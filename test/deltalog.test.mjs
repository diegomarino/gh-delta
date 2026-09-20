import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDeltaLog,
  deltaLogPath,
  readCursor,
  readDeltaLog,
  setCursorAtomic,
} from '../lib/deltalog.mjs';
import { acquireLock, assertLockOwned, extendLockDeadline, releaseLock } from '../lib/lock.mjs';

function tempPath(name) {
  return join(mkdtempSync(join(tmpdir(), 'gh-delta-log-')), name);
}

function manifestPath(logFile) {
  return `${logFile}.published.json`;
}

function readManifest(logFile) {
  return JSON.parse(readFileSync(manifestPath(logFile), 'utf8'));
}

const first = {
  id: 'a'.repeat(64),
  entity: 'pr',
  number: 42,
  title: 'one',
  classes: ['ci-changed'],
};
const second = {
  id: 'b'.repeat(64),
  entity: 'issue',
  number: 7,
  title: 'two',
  classes: ['new'],
};

test('delta log path is injective and explicit snapshots derive a sibling log', () => {
  assert.notEqual(
    deltaLogPath({ stateDir: '/state', repo: 'a/b-c', monitorId: 'm', entities: 'pr' }),
    deltaLogPath({ stateDir: '/state', repo: 'a-b/c', monitorId: 'm', entities: 'pr' }),
  );
  assert.equal(
    deltaLogPath({ stateFile: '/state/snapshot.json' }),
    '/state/snapshot.json.deltalog.ndjson',
  );
});

test('append writes contiguous, exact NDJSON records and reader scans them', () => {
  const logFile = tempPath('events.ndjson');
  assert.deepEqual(
    appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] }),
    {
      fromSeq: 1,
      toSeq: 1,
      appended: 1,
    },
  );
  assert.deepEqual(
    appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] }),
    {
      fromSeq: 2,
      toSeq: 2,
      appended: 1,
    },
  );
  assert.deepEqual(readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse), [
    { seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first },
    { seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second },
  ]);
  assert.deepEqual(readDeltaLog(logFile, { afterSeq: 0 }), {
    entries: [
      { seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first },
      { seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second },
    ],
    scannedTo: 2,
    firstSeq: 1,
    lastSeq: 2,
    trailingPartial: false,
  });
  assert.deepEqual(readManifest(logFile), {
    version: 1,
    lastSeq: 2,
    byteLength: Buffer.byteLength(readFileSync(logFile, 'utf8')),
  });
});

test('reader advances only through the manifest prefix while fsync fails, then recovery re-delivers the suffix', () => {
  const logFile = tempPath('publication.ndjson');
  const cursorPath = `${logFile}.cursor.json`;
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  let observedDuringFailedFsync;
  assert.throws(
    () =>
      appendDeltaLog(
        logFile,
        { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] },
        {
          fs: {
            fsyncSync() {
              observedDuringFailedFsync = readDeltaLog(logFile, { afterSeq: 0 });
              setCursorAtomic(cursorPath, {
                cursorVersion: 1,
                logFile,
                seq: observedDuringFailedFsync.scannedTo,
              });
              throw new Error('fsync failed');
            },
          },
        },
      ),
    /fsync failed/,
  );
  assert.deepEqual(
    observedDuringFailedFsync.entries.map((entry) => entry.seq),
    [1],
  );
  assert.equal(observedDuringFailedFsync.scannedTo, 1);
  assert.equal(readCursor(cursorPath).seq, 1);
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:02:00.000Z', deltas: [first] });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: readCursor(cursorPath).seq }).entries.map(
      (entry) => entry.seq,
    ),
    [2, 3],
  );
});

test('afterSeq beyond the published manifest tail is a log error even with a newline suffix', () => {
  const logFile = tempPath('cursor-ahead.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  writeFileSync(
    logFile,
    `${readFileSync(logFile, 'utf8')}${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second })}\n`,
  );
  assert.throws(() => readDeltaLog(logFile, { afterSeq: 2 }), /above published tail/);
});

test('manifest-backed append reads only the unpublished suffix, not the full log', () => {
  const logFile = tempPath('bounded.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] },
    {
      fs: {
        readFileSync(path, ...rest) {
          assert.notEqual(path, logFile, 'ordinary append must not read the committed log prefix');
          return readFileSync(path, ...rest);
        },
      },
    },
  );
  assert.equal(readManifest(logFile).lastSeq, 2);
});

test('valid complete suffix is promoted before the next append and preserves sequence', () => {
  const logFile = tempPath('recover-complete.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  writeFileSync(
    logFile,
    `${readFileSync(logFile, 'utf8')}${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second })}\n`,
  );
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:02:00.000Z', deltas: [first] });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.equal(readManifest(logFile).lastSeq, 3);
});

test('partial suffix is truncated during manifest recovery and malformed complete suffix is never mutated', () => {
  const partial = tempPath('recover-partial.ndjson');
  appendDeltaLog(partial, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  writeFileSync(partial, `${readFileSync(partial, 'utf8')}{"seq":2`);
  appendDeltaLog(partial, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] });
  assert.deepEqual(
    readDeltaLog(partial, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2],
  );

  const malformed = tempPath('recover-malformed.ndjson');
  appendDeltaLog(malformed, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  writeFileSync(malformed, `${readFileSync(malformed, 'utf8')}{bad}\n`);
  const before = readFileSync(malformed, 'utf8');
  assert.throws(
    () => appendDeltaLog(malformed, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] }),
    /malformed complete JSON line/,
  );
  assert.equal(readFileSync(malformed, 'utf8'), before);
});

test('manifest ahead of or beyond a truncated log is a permanent log error', () => {
  const logFile = tempPath('manifest-ahead.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  const manifest = readManifest(logFile);
  writeFileSync(manifestPath(logFile), JSON.stringify({ ...manifest, lastSeq: 2 }));
  assert.throws(() => readDeltaLog(logFile, { afterSeq: 0 }), /manifest/);
  writeFileSync(
    manifestPath(logFile),
    JSON.stringify({ ...manifest, byteLength: manifest.byteLength + 1 }),
  );
  assert.throws(() => readDeltaLog(logFile, { afterSeq: 0 }), /manifest/);
});

test('append rejects an invalid delta before changing existing log bytes', () => {
  const logFile = tempPath('preserve.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  const before = readFileSync(logFile, 'utf8');

  assert.throws(
    () =>
      appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [{ id: 'x' }] }),
    /delta must include entity, number, and classes/,
  );
  assert.equal(readFileSync(logFile, 'utf8'), before);
});

test('append rejects sparse classes after serialization and preserves existing bytes', () => {
  const logFile = tempPath('sparse.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  const before = readFileSync(logFile, 'utf8');
  const sparse = { ...second, classes: Array(1) };

  assert.throws(
    () => appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [sparse] }),
    /delta must include entity, number, and classes/,
  );
  assert.equal(readFileSync(logFile, 'utf8'), before);
});

function assertStaleAppendCannotDeleteWinner({ partialTail }) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-lock-log-'));
  const stateFile = join(dir, 'state.json');
  const logFile = `${stateFile}.deltalog.ndjson`;
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  if (partialTail) writeFileSync(logFile, `${readFileSync(logFile, 'utf8')}{"seq":2`);

  const stale = acquireLock(stateFile, { ghTimeoutMs: 1, staleMs: 1000, now: () => 0 });
  assert.equal(stale.ok, true);
  let winner;
  const winnerDelta = { ...second, id: 'c'.repeat(64) };
  try {
    assert.throws(
      () =>
        appendDeltaLog(
          logFile,
          { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] },
          {
            onProgress: () =>
              extendLockDeadline(stateFile, stale.token, {
                ghTimeoutMs: 1,
                now: () => 0,
              }),
            verifyBeforeMutation: () => {
              if (!winner) {
                winner = acquireLock(stateFile, {
                  ghTimeoutMs: 1,
                  staleMs: 1000,
                  now: () => 10000,
                });
                assert.equal(winner.ok, true);
                appendDeltaLog(logFile, {
                  detectedAt: '2026-09-20T12:01:00.000Z',
                  deltas: [winnerDelta],
                });
              }
              return assertLockOwned(stateFile, stale.token);
            },
          },
        ),
      (error) => error?.code === 'LOCK_LOST',
    );
    const entries = readDeltaLog(logFile, { afterSeq: 0 }).entries;
    assert.deepEqual(
      entries.map((entry) => [entry.seq, entry.id]),
      [
        [1, first.id],
        [2, winnerDelta.id],
      ],
    );
    assert.deepEqual(readManifest(logFile), {
      version: 1,
      lastSeq: 2,
      byteLength: Buffer.byteLength(readFileSync(logFile, 'utf8')),
    });
  } finally {
    if (winner?.ok) releaseLock(stateFile, winner.token);
    releaseLock(stateFile, stale.token);
  }
}

test('complete-tail lease theft preserves the winner journal record and rejects stale append', () => {
  assertStaleAppendCannotDeleteWinner({ partialTail: false });
});

test('partial-tail lease theft preserves the winner journal record and rejects stale append', () => {
  assertStaleAppendCannotDeleteWinner({ partialTail: true });
});

test('a retry after a durable append records the same id at a later sequence', () => {
  const logFile = tempPath('retry.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [first] });
  const entries = readDeltaLog(logFile, { afterSeq: 0 }).entries;
  assert.deepEqual(
    entries.map((entry) => [entry.seq, entry.id]),
    [
      [1, first.id],
      [2, first.id],
    ],
  );
});

test('reader hides a crash partial tail behind the published boundary and append removes it', () => {
  const logFile = tempPath('events.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  writeFileSync(logFile, `${readFileSync(logFile, 'utf8')}{"seq":2`);
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1],
  );
  assert.equal(readDeltaLog(logFile, { afterSeq: 0 }).trailingPartial, false);
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2],
  );
});

test('reader sees only prior complete records during a controlled partial append', () => {
  const logFile = tempPath('partial-live.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first] });
  let duringAppend;
  let firstWrite = true;
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second] },
    {
      fs: {
        closeSync,
        fsyncSync,
        ftruncateSync,
        mkdirSync,
        openSync,
        readFileSync,
        writeSync(fd, bytes, offset, length, position) {
          if (firstWrite) {
            firstWrite = false;
            const written = writeSync(fd, bytes, offset, Math.min(length - 1, 8), position);
            duringAppend = readDeltaLog(logFile, { afterSeq: 0 });
            return written;
          }
          return writeSync(fd, bytes, offset, length, position);
        },
      },
    },
  );
  assert.deepEqual(
    duringAppend.entries.map((entry) => entry.seq),
    [1],
  );
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2],
  );
});

test('independent cursors can filter one shared log without affecting each other', () => {
  const logFile = tempPath('shared.ndjson');
  appendDeltaLog(logFile, { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first, second] });
  const workerA = tempPath('a.cursor.json');
  const workerB = tempPath('b.cursor.json');
  const workerC = tempPath('c.cursor.json');
  for (const cursor of [workerA, workerB, workerC]) {
    setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
  }
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: readCursor(workerA).seq }).entries.map(
      (entry) => entry.delta.number,
    ),
    [42, 7],
  );
  assert.deepEqual(
    readDeltaLog(logFile, {
      afterSeq: readCursor(workerB).seq,
      select: (entry) => entry.delta.number === 42,
    }).entries.map((entry) => entry.delta.number),
    [42],
  );
  setCursorAtomic(workerC, { cursorVersion: 1, logFile, seq: 2 });
  assert.deepEqual(readDeltaLog(logFile, { afterSeq: readCursor(workerC).seq }).entries, []);
});

test('complete malformed or nonmonotonic log records are permanent errors', () => {
  const malformed = tempPath('bad.ndjson');
  writeFileSync(malformed, '{not json}\n');
  assert.throws(() => readDeltaLog(malformed, { afterSeq: 0 }), /invalid delta log/);
  const duplicate = tempPath('duplicate.ndjson');
  writeFileSync(
    duplicate,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first })}\n${JSON.stringify({ seq: 1, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second })}\n`,
  );
  assert.throws(() => readDeltaLog(duplicate, { afterSeq: 0 }), /strictly contiguous/);
});

test('complete records reject a delta that is not an emitted delta shape', () => {
  const incomplete = tempPath('incomplete.ndjson');
  writeFileSync(
    incomplete,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: { id: first.id } })}\n`,
  );
  assert.throws(
    () => readDeltaLog(incomplete, { afterSeq: 0 }),
    /delta must include entity, number, and classes/,
  );
});

test('complete blank lines are permanent log errors, not skipped records', () => {
  const blank = tempPath('blank.ndjson');
  writeFileSync(
    blank,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first })}\n\n`,
  );
  assert.throws(() => readDeltaLog(blank, { afterSeq: 0 }), /malformed complete JSON line/);
});

test('cursor writes atomically, validates binding, and preserves old bytes on replacement failure', () => {
  const cursor = tempPath('worker.cursor.json');
  const logFile = '/tmp/events.ndjson';
  setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
  assert.deepEqual(readCursor(cursor), { cursorVersion: 1, logFile, seq: 0 });
  const before = readFileSync(cursor, 'utf8');
  assert.throws(
    () =>
      setCursorAtomic(
        cursor,
        { cursorVersion: 1, logFile, seq: 1 },
        {
          fs: {
            mkdirSync() {},
            writeFileSync() {},
            renameSync() {
              throw new Error('rename failed');
            },
            unlinkSync() {},
          },
        },
      ),
    /rename failed/,
  );
  assert.equal(readFileSync(cursor, 'utf8'), before);
  assert.throws(
    () => setCursorAtomic(cursor, { cursorVersion: 1, logFile: 'relative.ndjson', seq: 0 }),
    /absolute/,
  );
});
