import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  appendDeltaLog,
  compactDeltaLog,
  deltaLogPath,
  readCursor,
  readDeltaLog,
  resetDeltaLog,
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

// Hand-build a raw log file plus its v3 manifest, bypassing appendDeltaLog,
// so a test can exercise content validation (malformed JSON, non-contiguous
// seq, an invalid delta shape, ...) without tripping the "no manifest at all"
// pre-manifest-format rejection that now applies to a bare, unmanifested file.
function writeRawManifestedLog(path, content, { lastSeq }) {
  writeFileSync(path, content);
  writeFileSync(
    manifestPath(path),
    JSON.stringify({
      version: 3,
      firstSeq: 1,
      dataFile: basename(path),
      lastSeq,
      byteLength: Buffer.byteLength(content),
    }),
  );
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
const REPO = 'o/r';
const MONITOR = 'm';

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
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:00:00.000Z',
      deltas: [first],
      repo: REPO,
      monitorId: MONITOR,
    }),
    {
      fromSeq: 1,
      toSeq: 1,
      appended: 1,
    },
  );
  assert.deepEqual(
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:01:00.000Z',
      deltas: [second],
      repo: REPO,
      monitorId: MONITOR,
    }),
    {
      fromSeq: 2,
      toSeq: 2,
      appended: 1,
    },
  );
  assert.deepEqual(readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse), [
    {
      seq: 1,
      id: first.id,
      detectedAt: '2026-09-20T12:00:00.000Z',
      delta: first,
      repo: REPO,
      monitorId: MONITOR,
    },
    {
      seq: 2,
      id: second.id,
      detectedAt: '2026-09-20T12:01:00.000Z',
      delta: second,
      repo: REPO,
      monitorId: MONITOR,
    },
  ]);
  assert.deepEqual(readDeltaLog(logFile, { afterSeq: 0 }), {
    entries: [
      {
        seq: 1,
        id: first.id,
        detectedAt: '2026-09-20T12:00:00.000Z',
        delta: first,
        repo: REPO,
        monitorId: MONITOR,
      },
      {
        seq: 2,
        id: second.id,
        detectedAt: '2026-09-20T12:01:00.000Z',
        delta: second,
        repo: REPO,
        monitorId: MONITOR,
      },
    ],
    scannedTo: 2,
    firstSeq: 1,
    lastSeq: 2,
    trailingPartial: false,
  });
  assert.deepEqual(readManifest(logFile), {
    version: 3,
    firstSeq: 1,
    dataFile: basename(logFile),
    lastSeq: 2,
    byteLength: Buffer.byteLength(readFileSync(logFile, 'utf8')),
  });
});

test('compaction keeps original sequence numbers and an empty prefix appends from the old tail', () => {
  const logFile = tempPath('compact-sequences.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first, second],
    repo: REPO,
    monitorId: MONITOR,
  });
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:01:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });

  assert.deepEqual(compactDeltaLog(logFile, { keep: { count: 1 } }), {
    previous: { firstSeq: 1, lastSeq: 3, count: 3 },
    retained: { firstSeq: 3, lastSeq: 3, count: 1 },
  });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [3],
  );
  assert.deepEqual(
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:02:00.000Z',
      deltas: [second],
      repo: REPO,
      monitorId: MONITOR,
    }),
    { fromSeq: 4, toSeq: 4, appended: 1 },
  );

  compactDeltaLog(logFile, { keep: { count: 0 } });
  assert.deepEqual(readDeltaLog(logFile, { afterSeq: 4 }).entries, []);
  assert.deepEqual(
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:03:00.000Z',
      deltas: [first],
      repo: REPO,
      monitorId: MONITOR,
    }),
    { fromSeq: 5, toSeq: 5, appended: 1 },
  );
});

test('duration compaction keeps a contiguous suffix when detectedAt moves backward', () => {
  const logFile = tempPath('compact-clock-skew.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T10:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T13:00:00.000Z',
    deltas: [second],
    repo: REPO,
    monitorId: MONITOR,
  });
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T11:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });

  compactDeltaLog(logFile, { keep: { sinceMs: Date.parse('2026-09-20T12:00:00.000Z') } });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [2, 3],
  );
  assert.deepEqual(
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T14:00:00.000Z',
      deltas: [second],
      repo: REPO,
      monitorId: MONITOR,
    }),
    { fromSeq: 4, toSeq: 4, appended: 1 },
  );
});

test('a manifest durability failure leaves one complete compacted publication readable', () => {
  const logFile = tempPath('compact-manifest-fsync.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first, second],
    repo: REPO,
    monitorId: MONITOR,
  });
  const parent = dirname(manifestPath(logFile));
  const descriptors = new Map();
  assert.throws(
    () =>
      compactDeltaLog(
        logFile,
        { keep: { count: 1 } },
        {
          fs: {
            closeSync(fd) {
              descriptors.delete(fd);
              return closeSync(fd);
            },
            openSync(path, flags) {
              const fd = openSync(path, flags);
              descriptors.set(fd, path);
              return fd;
            },
            fsyncSync(fd) {
              if (descriptors.get(fd) === parent) throw new Error('directory fsync failed');
              return fsyncSync(fd);
            },
          },
          uniqueSuffix: () => 'durability-failure',
        },
      ),
    /directory fsync failed/,
  );
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [2],
  );
});

test('a reader that selected a cleaned generation retries against the current manifest', () => {
  const logFile = tempPath('compact-reader-race.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first, second],
    repo: REPO,
    monitorId: MONITOR,
  });
  compactDeltaLog(logFile, { keep: { count: 1 } }, { uniqueSuffix: () => 'current' });
  const currentManifest = readFileSync(manifestPath(logFile), 'utf8');
  const missingManifest = JSON.stringify({
    version: 3,
    dataFile: 'cleaned-generation.ndjson',
    firstSeq: 1,
    lastSeq: 2,
    byteLength: 10,
  });
  let manifestReads = 0;
  const result = readDeltaLog(
    logFile,
    { afterSeq: 0 },
    {
      fs: {
        readFileSync(path, encoding) {
          if (path === manifestPath(logFile)) {
            manifestReads++;
            // One manifest read per readDeltaLogOnce attempt: the first
            // (racing a since-cleaned generation) fails with
            // GENERATION_MISSING, and readDeltaLog retries once more.
            if (manifestReads <= 1) return missingManifest;
            return currentManifest;
          }
          return readFileSync(path, encoding);
        },
      },
    },
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.seq),
    [2],
  );
  assert.equal(manifestReads, 2);
});

test('manifest publication fsyncs its parent directory after rename before append returns', () => {
  const logFile = tempPath('manifest-directory-order.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const manifest = manifestPath(logFile);
  const parent = dirname(manifest);
  const descriptors = new Map();
  const events = [];
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second], repo: REPO, monitorId: MONITOR },
    {
      fs: {
        closeSync(fd) {
          if (descriptors.get(fd) === parent) events.push('directory-close');
          return closeSync(fd);
        },
        fsyncSync(fd) {
          const path = descriptors.get(fd);
          if (path === logFile) events.push('log-fsync');
          if (path.startsWith(`${manifest}.`)) events.push('manifest-temp-fsync');
          if (path === parent) events.push('directory-fsync');
          return fsyncSync(fd);
        },
        openSync(path, flags) {
          const fd = openSync(path, flags);
          descriptors.set(fd, path);
          if (path === parent) events.push(`directory-open:${flags}`);
          return fd;
        },
        renameSync(from, to) {
          if (from.startsWith(`${manifest}.`) && to === manifest) events.push('manifest-rename');
          return renameSync(from, to);
        },
      },
    },
  );
  assert.deepEqual(events, [
    'log-fsync',
    'manifest-temp-fsync',
    'manifest-rename',
    'directory-open:r',
    'directory-fsync',
    'directory-close',
  ]);
});

test('manifest durability targets the parent on POSIX and final manifest on win32', () => {
  for (const [platform, expectedFlags] of [
    ['darwin', 'r'],
    ['win32', 'r+'],
  ]) {
    const logFile = tempPath(`manifest-directory-${platform}.ndjson`);
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:00:00.000Z',
      deltas: [first],
      repo: REPO,
      monitorId: MONITOR,
    });
    const manifest = manifestPath(logFile);
    const parent = dirname(manifest);
    const opened = [];
    appendDeltaLog(
      logFile,
      { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second], repo: REPO, monitorId: MONITOR },
      {
        platform,
        fs: {
          openSync(path, mode) {
            if (path === parent || path === manifest) {
              opened.push([path, mode]);
              return 99;
            }
            return openSync(path, mode);
          },
          fsyncSync(fd) {
            if (fd === 99) return undefined;
            return fsyncSync(fd);
          },
          closeSync(fd) {
            if (fd === 99) return undefined;
            return closeSync(fd);
          },
        },
      },
    );
    assert.deepEqual(opened, [[platform === 'win32' ? manifest : parent, expectedFlags]]);
  }
});

test('reader advances only through the manifest prefix while fsync fails, then recovery re-delivers the suffix', () => {
  const logFile = tempPath('publication.ndjson');
  const cursorPath = `${logFile}.cursor.json`;
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  let observedDuringFailedFsync;
  assert.throws(
    () =>
      appendDeltaLog(
        logFile,
        {
          detectedAt: '2026-09-20T12:01:00.000Z',
          deltas: [second],
          repo: REPO,
          monitorId: MONITOR,
        },
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:02:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: readCursor(cursorPath).seq }).entries.map(
      (entry) => entry.seq,
    ),
    [2, 3],
  );
});

test('first append publishes an empty boundary before a failed record fsync', () => {
  const logFile = tempPath('first-publication.ndjson');
  const cursorPath = `${logFile}.cursor.json`;
  let duringFailedFsync;
  const descriptors = new Map();
  assert.throws(
    () =>
      appendDeltaLog(
        logFile,
        { detectedAt: '2026-09-20T12:00:00.000Z', deltas: [first], repo: REPO, monitorId: MONITOR },
        {
          fs: {
            openSync(path, flags) {
              const fd = openSync(path, flags);
              descriptors.set(fd, path);
              return fd;
            },
            fsyncSync(fd) {
              if (descriptors.get(fd) !== logFile) return fsyncSync(fd);
              duringFailedFsync = readDeltaLog(logFile, { afterSeq: 0 });
              setCursorAtomic(cursorPath, {
                cursorVersion: 1,
                logFile,
                seq: duringFailedFsync.scannedTo,
              });
              throw new Error('first record fsync failed');
            },
          },
        },
      ),
    /first record fsync failed/,
  );
  assert.deepEqual(duringFailedFsync.entries, []);
  assert.equal(duringFailedFsync.scannedTo, 0);
  assert.equal(readCursor(cursorPath).seq, 0);
});

test('a pre-manifest raw log file is rejected by both append and read, naming reset, without mutation', () => {
  const logFile = tempPath('legacy-no-manifest.ndjson');
  const legacyRecord = {
    seq: 1,
    id: first.id,
    detectedAt: '2026-09-20T12:00:00.000Z',
    delta: first,
  };
  writeFileSync(logFile, `${JSON.stringify(legacyRecord)}\n`);
  const before = readFileSync(logFile);

  assert.throws(
    () => readDeltaLog(logFile, { afterSeq: 0 }),
    (error) =>
      error?.kind === 'log' &&
      /predates the schema-v2 manifest format/.test(error.message) &&
      /gh-delta reset/.test(error.message),
  );
  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:01:00.000Z',
        deltas: [second],
        repo: REPO,
        monitorId: MONITOR,
      }),
    (error) =>
      error?.kind === 'log' &&
      /predates the schema-v2 manifest format/.test(error.message) &&
      /gh-delta reset/.test(error.message),
  );
  // Neither the rejected read nor the rejected append mutated the raw file.
  assert.deepEqual(readFileSync(logFile), before);
});

function recordWithInvalidTitleByte(record) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const title = Buffer.from(`"title":"${record.delta.title}"`);
  const titleStart = bytes.indexOf(title);
  assert.ok(titleStart >= 0);
  bytes[titleStart + Buffer.byteLength('"title":"')] = 0x80;
  return bytes;
}

test('invalid UTF-8 in a complete unpublished suffix is a log error without mutation', () => {
  const logFile = tempPath('invalid-suffix-utf8.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const invalidSuffix = recordWithInvalidTitleByte({
    seq: 2,
    id: second.id,
    detectedAt: '2026-09-20T12:01:00.000Z',
    delta: second,
  });
  writeFileSync(logFile, Buffer.concat([readFileSync(logFile), invalidSuffix]));
  const before = readFileSync(logFile);
  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:02:00.000Z',
        deltas: [first],
        repo: REPO,
        monitorId: MONITOR,
      }),
    /invalid UTF-8/,
  );
  assert.deepEqual(readFileSync(logFile), before);
});

test('BOM-prefixed complete suffix is rejected without changing the journal or manifest', () => {
  const logFile = tempPath('bom-suffix.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const record = Buffer.from(
    `${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second, repo: REPO, monitorId: MONITOR })}\n`,
  );
  writeFileSync(
    logFile,
    Buffer.concat([readFileSync(logFile), Buffer.from([0xef, 0xbb, 0xbf]), record]),
  );
  const beforeLog = readFileSync(logFile);
  const beforeManifest = readFileSync(manifestPath(logFile));
  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:02:00.000Z',
        deltas: [first],
        repo: REPO,
        monitorId: MONITOR,
      }),
    (error) => error?.kind === 'log',
  );
  assert.deepEqual(readFileSync(logFile), beforeLog);
  assert.deepEqual(readFileSync(manifestPath(logFile)), beforeManifest);
});

test('reader rejects invalid UTF-8 inside its published prefix', () => {
  const logFile = tempPath('invalid-prefix-utf8.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const bytes = readFileSync(logFile);
  const title = Buffer.from('"title":"one"');
  const titleStart = bytes.indexOf(title);
  assert.ok(titleStart >= 0);
  bytes[titleStart + Buffer.byteLength('"title":"')] = 0x80;
  writeFileSync(logFile, bytes);
  assert.throws(() => readDeltaLog(logFile, { afterSeq: 0 }), /invalid UTF-8/);
});

test('complete-suffix recovery fsync opens the log writable', () => {
  const logFile = tempPath('recovery-writable-fsync.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(
    logFile,
    `${readFileSync(logFile, 'utf8')}${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second, repo: REPO, monitorId: MONITOR })}\n`,
  );
  const openModes = [];
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:02:00.000Z', deltas: [first], repo: REPO, monitorId: MONITOR },
    {
      fs: {
        openSync(path, flags) {
          if (path === logFile) openModes.push(flags);
          return openSync(path, flags);
        },
      },
    },
  );
  assert.ok(openModes.includes('r+'));
});

test('afterSeq beyond the published manifest tail is a log error even with a newline suffix', () => {
  const logFile = tempPath('cursor-ahead.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(
    logFile,
    `${readFileSync(logFile, 'utf8')}${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second, repo: REPO, monitorId: MONITOR })}\n`,
  );
  assert.throws(() => readDeltaLog(logFile, { afterSeq: 2 }), /above published tail/);
});

test('manifest-backed append reads only the unpublished suffix, not the full log', () => {
  const logFile = tempPath('bounded.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second], repo: REPO, monitorId: MONITOR },
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(
    logFile,
    `${readFileSync(logFile, 'utf8')}${JSON.stringify({ seq: 2, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second, repo: REPO, monitorId: MONITOR })}\n`,
  );
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:02:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.equal(readManifest(logFile).lastSeq, 3);
});

test('partial suffix is truncated during manifest recovery and malformed complete suffix is never mutated', () => {
  const partial = tempPath('recover-partial.ndjson');
  appendDeltaLog(partial, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(partial, `${readFileSync(partial, 'utf8')}{"seq":2`);
  appendDeltaLog(partial, {
    detectedAt: '2026-09-20T12:01:00.000Z',
    deltas: [second],
    repo: REPO,
    monitorId: MONITOR,
  });
  assert.deepEqual(
    readDeltaLog(partial, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2],
  );

  const malformed = tempPath('recover-malformed.ndjson');
  appendDeltaLog(malformed, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(malformed, `${readFileSync(malformed, 'utf8')}{bad}\n`);
  const before = readFileSync(malformed, 'utf8');
  assert.throws(
    () =>
      appendDeltaLog(malformed, {
        detectedAt: '2026-09-20T12:01:00.000Z',
        deltas: [second],
        repo: REPO,
        monitorId: MONITOR,
      }),
    /malformed complete JSON line/,
  );
  assert.equal(readFileSync(malformed, 'utf8'), before);
});

test('manifest ahead of or beyond a truncated log is a permanent log error', () => {
  const logFile = tempPath('manifest-ahead.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const before = readFileSync(logFile, 'utf8');

  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:01:00.000Z',
        deltas: [{ id: 'x' }],
        repo: REPO,
        monitorId: MONITOR,
      }),
    /delta must include entity, number, and classes/,
  );
  assert.equal(readFileSync(logFile, 'utf8'), before);
});

test('append rejects sparse classes after serialization and preserves existing bytes', () => {
  const logFile = tempPath('sparse.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  const before = readFileSync(logFile, 'utf8');
  const sparse = { ...second, classes: Array(1) };

  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:01:00.000Z',
        deltas: [sparse],
        repo: REPO,
        monitorId: MONITOR,
      }),
    /delta must include entity, number, and classes/,
  );
  assert.equal(readFileSync(logFile, 'utf8'), before);
});

function assertStaleAppendCannotDeleteWinner({ partialTail }) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-lock-log-'));
  const stateFile = join(dir, 'state.json');
  const logFile = `${stateFile}.deltalog.ndjson`;
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
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
          {
            detectedAt: '2026-09-20T12:01:00.000Z',
            deltas: [second],
            repo: REPO,
            monitorId: MONITOR,
          },
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
                  repo: REPO,
                  monitorId: MONITOR,
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
      version: 3,
      firstSeq: 1,
      dataFile: basename(logFile),
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:01:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  writeFileSync(logFile, `${readFileSync(logFile, 'utf8')}{"seq":2`);
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1],
  );
  assert.equal(readDeltaLog(logFile, { afterSeq: 0 }).trailingPartial, false);
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:01:00.000Z',
    deltas: [second],
    repo: REPO,
    monitorId: MONITOR,
  });
  assert.deepEqual(
    readDeltaLog(logFile, { afterSeq: 0 }).entries.map((entry) => entry.seq),
    [1, 2],
  );
});

test('reader sees only prior complete records during a controlled partial append', () => {
  const logFile = tempPath('partial-live.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  let duringAppend;
  let firstWrite = true;
  appendDeltaLog(
    logFile,
    { detectedAt: '2026-09-20T12:01:00.000Z', deltas: [second], repo: REPO, monitorId: MONITOR },
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
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first, second],
    repo: REPO,
    monitorId: MONITOR,
  });
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
  writeRawManifestedLog(malformed, '{not json}\n', { lastSeq: 1 });
  assert.throws(() => readDeltaLog(malformed, { afterSeq: 0 }), /invalid delta log/);
  const duplicate = tempPath('duplicate.ndjson');
  writeRawManifestedLog(
    duplicate,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first, repo: REPO, monitorId: MONITOR })}\n${JSON.stringify({ seq: 1, id: second.id, detectedAt: '2026-09-20T12:01:00.000Z', delta: second, repo: REPO, monitorId: MONITOR })}\n`,
    { lastSeq: 2 },
  );
  assert.throws(() => readDeltaLog(duplicate, { afterSeq: 0 }), /strictly contiguous/);
});

test('complete records reject a delta that is not an emitted delta shape', () => {
  const incomplete = tempPath('incomplete.ndjson');
  writeRawManifestedLog(
    incomplete,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: { id: first.id }, repo: REPO, monitorId: MONITOR })}\n`,
    { lastSeq: 1 },
  );
  assert.throws(
    () => readDeltaLog(incomplete, { afterSeq: 0 }),
    /delta must include entity, number, and classes/,
  );
});

test('complete blank lines are permanent log errors, not skipped records', () => {
  const blank = tempPath('blank.ndjson');
  writeRawManifestedLog(
    blank,
    `${JSON.stringify({ seq: 1, id: first.id, detectedAt: '2026-09-20T12:00:00.000Z', delta: first, repo: REPO, monitorId: MONITOR })}\n\n`,
    { lastSeq: 1 },
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

test('a v1 or v2 manifest is rejected by both append and read, naming reset', () => {
  for (const legacyManifest of [
    { version: 1, lastSeq: 1, byteLength: 50 },
    { version: 2, firstSeq: 1, lastSeq: 1, byteLength: 50 },
  ]) {
    const logFile = tempPath(`legacy-manifest-v${legacyManifest.version}.ndjson`);
    appendDeltaLog(logFile, {
      detectedAt: '2026-09-20T12:00:00.000Z',
      deltas: [first],
      repo: REPO,
      monitorId: MONITOR,
    });
    writeFileSync(manifestPath(logFile), JSON.stringify(legacyManifest));
    assert.throws(
      () => readDeltaLog(logFile, { afterSeq: 0 }),
      (error) => error?.kind === 'log' && /gh-delta reset/.test(error.message),
    );
    assert.throws(
      () =>
        appendDeltaLog(logFile, {
          detectedAt: '2026-09-20T12:01:00.000Z',
          deltas: [second],
          repo: REPO,
          monitorId: MONITOR,
        }),
      (error) => error?.kind === 'log' && /gh-delta reset/.test(error.message),
    );
  }
});

test('a log file with bytes but no manifest (pre-schema-v2) is rejected, not silently bootstrapped', () => {
  const logFile = tempPath('unmanifested.ndjson');
  const legacyRecord = {
    seq: 1,
    id: first.id,
    detectedAt: '2026-09-20T12:00:00.000Z',
    delta: first,
  };
  writeFileSync(logFile, `${JSON.stringify(legacyRecord)}\n`);

  assert.throws(
    () => readDeltaLog(logFile, { afterSeq: 0 }),
    (error) =>
      error?.kind === 'log' && /predates the schema-v2 manifest format/.test(error.message),
  );
  const beforeBytes = readFileSync(logFile);
  assert.throws(
    () =>
      appendDeltaLog(logFile, {
        detectedAt: '2026-09-20T12:01:00.000Z',
        deltas: [second],
        repo: REPO,
        monitorId: MONITOR,
      }),
    (error) =>
      error?.kind === 'log' && /predates the schema-v2 manifest format/.test(error.message),
  );
  // Neither rejection may have mutated the pre-existing bytes.
  assert.deepEqual(readFileSync(logFile), beforeBytes);
});

test('resetDeltaLog deletes the manifest and data file, and is idempotent on a clean/never-appended log', () => {
  const logFile = tempPath('reset-me.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first],
    repo: REPO,
    monitorId: MONITOR,
  });
  assert.ok(existsSync(logFile));
  assert.ok(existsSync(manifestPath(logFile)));

  resetDeltaLog(logFile);
  assert.equal(existsSync(logFile), false);
  assert.equal(existsSync(manifestPath(logFile)), false);

  // Idempotent: resetting an already-clean (never-appended) log is a no-op.
  assert.doesNotThrow(() => resetDeltaLog(logFile));
});

test('resetDeltaLog recovers the dataFile from a schema-invalid-but-parseable manifest, deleting the compacted generation file too', () => {
  // A manifest that is valid JSON naming a real, same-directory dataFile, but
  // fails full validateManifest() (an extra field trips the strict key
  // check). Reset's whole point is recovering from exactly this kind of
  // corruption -- falling all the way back to `logFile` here would leave
  // this generation file, and every historical delta in it, on disk while
  // reset reports success.
  const logFile = tempPath('reset-invalid-manifest.ndjson');
  const dir = dirname(logFile);
  const genFile = join(dir, 'gen-1.ndjson');
  writeFileSync(genFile, '');
  writeFileSync(logFile, '');
  writeFileSync(
    manifestPath(logFile),
    JSON.stringify({
      version: 3,
      firstSeq: 1,
      lastSeq: 1,
      byteLength: 0,
      dataFile: 'gen-1.ndjson',
      extra: 'field',
    }),
  );
  assert.ok(existsSync(genFile));

  resetDeltaLog(logFile);

  assert.equal(existsSync(genFile), false);
  assert.equal(existsSync(logFile), false);
  assert.equal(existsSync(manifestPath(logFile)), false);
});

test('resetDeltaLog never unlinks a dataFile outside the log directory, even from a crafted manifest', () => {
  // dataFile fails the same same-directory-basename check validateManifest
  // enforces -- the recovery path must honor that exact check, or a crafted
  // manifest could make reset delete an arbitrary path.
  const logFile = tempPath('reset-traversal-manifest.ndjson');
  const outsideDir = mkdtempSync(join(tmpdir(), 'gh-delta-outside-'));
  const outsideFile = join(outsideDir, 'victim.ndjson');
  writeFileSync(outsideFile, 'do not delete');
  writeFileSync(logFile, '');
  writeFileSync(
    manifestPath(logFile),
    JSON.stringify({
      version: 3,
      firstSeq: 1,
      lastSeq: 1,
      byteLength: 0,
      dataFile: `../${basename(outsideDir)}/victim.ndjson`,
    }),
  );

  resetDeltaLog(logFile);

  assert.ok(existsSync(outsideFile), 'a path-traversal dataFile must never be unlinked');
  assert.equal(existsSync(logFile), false);
  assert.equal(existsSync(manifestPath(logFile)), false);
});

test('a cursor pointing past the tail of a reset (deleted) log is a clear log error, not a silent restart', () => {
  const logFile = tempPath('reset-cursor.ndjson');
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [first, second],
    repo: REPO,
    monitorId: MONITOR,
  });
  const cursorSeq = readDeltaLog(logFile, { afterSeq: 0 }).scannedTo;
  assert.equal(cursorSeq, 2);

  resetDeltaLog(logFile);

  // The consumer's cursor still names seq 2, but the reset log is now empty
  // (lastSeq 0): silently restarting from the new firstSeq would re-deliver
  // history the consumer already believes it consumed, so this must throw
  // instead -- the documented recovery is to delete the stale cursor.
  assert.throws(
    () => readDeltaLog(logFile, { afterSeq: cursorSeq }),
    (error) => error?.kind === 'log' && /above published tail/.test(error.message),
  );
});
