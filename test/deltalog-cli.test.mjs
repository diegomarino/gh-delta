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
import { dirname, join, resolve } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { appendDeltaLog, readCursor, readDeltaLog, setCursorAtomic } from '../lib/deltalog.mjs';

// Schema v2: a snapshot item is `{ fingerprint, context, meta }`.
const item = (fingerprint) => ({
  fingerprint,
  context: {},
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
  },
});

const before = {
  pr: {
    42: item({
      state: 'OPEN',
      updatedAt: '2026-09-20T10:00:00Z',
      isDraft: false,
      ci: 'a',
      review: 'REVIEW_REQUIRED',
      reviews: 'a',
      mergeable: 'UNKNOWN',
      comments: 0,
      head: 'one',
    }),
  },
  issue: {},
  // Schema v2 snapshot-wide meta is mandatory -- see lib/snapshot.mjs.
  meta: {
    schemaVersion: 2,
    ghDeltaVersion: '0.0.0-test',
    repo: 'o/r',
    monitorId: 'm',
    entities: ['pr'],
    scope: 'poll',
    horizon: '2026-09-20T11:00:00.000Z',
    createdAt: '2026-09-20T11:00:00.000Z',
    updatedAt: '2026-09-20T11:00:00.000Z',
  },
};
const pr = {
  number: 42,
  title: 'change',
  state: 'OPEN',
  updatedAt: '2026-09-20T11:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'two',
};
const lock = {
  acquireLock: () => ({ ok: true, token: 'lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
  extendLockDeadline: () => ({ ok: true }),
};

const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-09-20T13:00:00.000Z' };

function producerDeps(overrides = {}) {
  const events = [];
  return {
    ...lock,
    fetchPRs: () => ({ rows: [pr], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => before,
    writeSnapshotAtomic: () => events.push('snapshot'),
    appendDeltaLog: (file, payload) => events.push(['log', file, payload]),
    now: () => '2026-09-20T12:00:00.000Z',
    ...overrides,
    events,
  };
}

test('main --log appends emitted post-filter delta before snapshot and exposes logFile', () => {
  const deps = producerDeps();
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/state.json',
      '--entities',
      'pr',
      '--log',
    ],
    deps,
  );
  assert.equal(result.code, 10);
  assert.equal(result.report.logFile, '/tmp/state.json.deltalog.ndjson');
  assert.equal(deps.events[0][0], 'log');
  assert.equal(deps.events[1], 'snapshot');
  assert.equal(deps.events[0][2].deltas[0].id, result.report.deltas[0].id);
});

test('log compact retains a producer-derived suffix and read warns a cursor behind retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-compact-cli-'));
  const stateFile = join(dir, 'state.json');
  const log = `${stateFile}.deltalog.ndjson`;
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T10:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 1, title: 'old', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [{ id: 'b'.repeat(64), entity: 'pr', number: 2, title: 'new', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  const compacted = run(
    [
      'log',
      'compact',
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      stateFile,
      '--entities',
      'pr',
      '--keep',
      '1',
    ],
    { now: () => '2026-09-20T13:00:00.000Z' },
  );
  assert.equal(compacted.code, 0);
  assert.equal(compacted.report.retained.count, 1);
  assert.equal(compacted.report.retained.firstSeq, 2);
  const cursor = join(dir, 'cursor.json');
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  const read = run(['read', '--cursor', cursor, '--format', 'text'], {
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.equal(read.code, 10);
  assert.deepEqual(
    read.report.deltas.map((delta) => delta.number),
    [2],
  );
  assert.deepEqual(read.warnings, [{ label: 'retention', reason: 'cursor behind retention' }]);

  const safeCursor = join(dir, 'safe.cursor.json');
  setCursorAtomic(safeCursor, { cursorVersion: 1, logFile: log, seq: 1 });
  const safe = run(['read', '--cursor', safeCursor], {
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.deepEqual(safe.warnings, []);
});

test('duration compaction can retain zero records and warnings render in JSON and text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-compact-duration-'));
  const stateFile = join(dir, 'state.json');
  const log = `${stateFile}.deltalog.ndjson`;
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T10:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 1, title: 'old', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  const args = [
    'log',
    'compact',
    '--repo',
    'o/r',
    '--monitor-id',
    'm',
    '--state-file',
    stateFile,
    '--keep',
    '30m',
  ];
  const compacted = run(args, { now: () => '2026-09-20T13:00:00.000Z' });
  assert.equal(compacted.code, 0);
  assert.equal(compacted.report.retained.count, 0);
  assert.deepEqual(readDeltaLog(log, { afterSeq: 1 }).entries, []);

  const behind = join(dir, 'behind.cursor.json');
  setCursorAtomic(behind, { cursorVersion: 1, logFile: log, seq: 0 });
  const json = await runCommand(['read', '--cursor', behind], {
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.match(json.output, /"label": "retention"/);
  const text = await runCommand(['read', '--cursor', behind, '--format', 'text'], {
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.match(text.output, /warning \[retention\]: cursor behind retention/);
});

test('compact rejects unsafe duration before locking and reports lock contention as busy', () => {
  const common = ['log', 'compact', '--repo', 'o/r', '--state-file', '/tmp/state.json', '--keep'];
  const invalid = run([...common, '9007199254740992d'], {
    acquireLock: () => assert.fail('invalid keep must fail before lock acquisition'),
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.equal(invalid.code, 2);
  assert.equal(invalid.report.kind, 'config');

  const busy = run([...common, '1'], {
    acquireLock: () => ({ ok: false, reason: 'held' }),
    compactDeltaLog: () => assert.fail('busy compact must not read or mutate the log'),
    now: () => '2026-09-20T13:00:00.000Z',
  });
  assert.equal(busy.code, 1);
  assert.equal(busy.report.kind, 'busy');
});

test('--log resolves only opt-in log paths while preserving relative snapshot paths', () => {
  const stateFile = 'relative-state.json';
  const byFile = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', stateFile, '--entities', 'pr', '--log'],
    producerDeps(),
  );
  assert.equal(byFile.report.stateFile, stateFile);
  assert.equal(byFile.report.logFile, resolve(`${stateFile}.deltalog.ndjson`));

  const stateDir = 'relative-state-dir';
  const byDir = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-dir', stateDir, '--entities', 'pr', '--log'],
    producerDeps(),
  );
  assert.equal(byDir.report.stateFile, `${stateDir}/repo-o%2Fr__monitor-m__pr.json`);
  assert.equal(byDir.report.logFile, resolve(`${stateDir}/log-o%2Fr__monitor-m__pr.ndjson`));
});

test('actual append write and fsync finish before snapshot publication, and fsync failure blocks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-order-'));
  const events = [];
  const appendWithObservedFsync = (file, payload) =>
    appendDeltaLog(file, payload, {
      fs: {
        closeSync,
        fsyncSync(fd) {
          events.push('fsync');
          return fsyncSync(fd);
        },
        ftruncateSync,
        mkdirSync,
        openSync,
        readFileSync,
        writeSync(fd, bytes, offset, length, position) {
          events.push('write');
          return writeSync(fd, bytes, offset, length, position);
        },
      },
    });
  const success = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      join(dir, 'state.json'),
      '--entities',
      'pr',
      '--log',
    ],
    producerDeps({
      appendDeltaLog: appendWithObservedFsync,
      writeSnapshotAtomic: () => events.push('snapshot'),
    }),
  );
  assert.equal(success.code, 10);
  assert.ok(events.indexOf('write') < events.indexOf('fsync'));
  assert.ok(events.indexOf('fsync') < events.indexOf('snapshot'));

  const failedEvents = [];
  const failure = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      join(dir, 'failed.json'),
      '--entities',
      'pr',
      '--log',
    ],
    producerDeps({
      appendDeltaLog(file, payload) {
        return appendDeltaLog(file, payload, {
          fs: {
            closeSync,
            fsyncSync() {
              failedEvents.push('fsync');
              throw new Error('fsync failed');
            },
            ftruncateSync,
            mkdirSync,
            openSync,
            readFileSync,
            writeSync,
          },
        });
      },
      writeSnapshotAtomic: () => failedEvents.push('snapshot'),
    }),
  );
  assert.equal(failure.code, 1);
  assert.deepEqual(failedEvents, ['fsync']);
});

test('manifest directory fsync failure prevents snapshot publication and preserves prior snapshot bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-manifest-directory-failure-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify(before));
  const beforeBytes = readFileSync(stateFile);
  let snapshotCalls = 0;
  const result = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', stateFile, '--entities', 'pr', '--log'],
    producerDeps({
      appendDeltaLog(file, payload) {
        const parent = dirname(`${file}.published.json`);
        const descriptors = new Map();
        return appendDeltaLog(file, payload, {
          fs: {
            fsyncSync(fd) {
              if (descriptors.get(fd) === parent) throw new Error('directory fsync failed');
              return fsyncSync(fd);
            },
            openSync(path, flags) {
              const fd = openSync(path, flags);
              descriptors.set(fd, path);
              return fd;
            },
          },
        });
      },
      writeSnapshotAtomic: () => {
        snapshotCalls++;
      },
    }),
  );
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'io');
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(readFileSync(stateFile), beforeBytes);
});

test('snapshot failure after durable append retries the same id at a later sequence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-retry-'));
  const stateFile = join(dir, 'state.json');
  const firstAttempt = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', stateFile, '--entities', 'pr', '--log'],
    producerDeps({
      appendDeltaLog,
      writeSnapshotAtomic: () => {
        throw new Error('snapshot publish failed');
      },
    }),
  );
  assert.equal(firstAttempt.code, 1);
  const retry = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', stateFile, '--entities', 'pr', '--log'],
    producerDeps({ appendDeltaLog }),
  );
  assert.equal(retry.code, 10);
  const entries = readDeltaLog(retry.report.logFile, { afterSeq: 0 }).entries;
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2],
  );
  assert.equal(entries[0].id, entries[1].id);
  assert.equal(entries[1].id, retry.report.deltas[0].id);
});

test('attention filtering stores the exact fully decorated surviving report delta', () => {
  const deps = producerDeps();
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/state.json',
      '--entities',
      'pr',
      '--log',
      '--only-classes',
      'head-changed',
      '--summaries',
      '--detail',
    ],
    deps,
  );
  assert.equal(result.code, 10);
  const logged = deps.events.find(([kind]) => kind === 'log')[2].deltas;
  assert.deepEqual(logged, result.report.deltas);
  assert.ok(logged[0].summary);
  assert.ok(logged[0].summaryLine);
  assert.ok(logged[0].line);
  assert.ok(logged[0].details.length > 0);
});

test('no --log leaves the log seam unopened and report omits logFile', () => {
  const deps = producerDeps({ appendDeltaLog: () => assert.fail('log must not open') });
  const result = run(
    ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/state.json', '--entities', 'pr'],
    deps,
  );
  assert.equal(result.code, 10);
  assert.equal(result.report.logFile, undefined);
});

test('a zero-delta --log tick reports logFile but never opens the append seam', () => {
  const deps = producerDeps({
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({ pr: {}, issue: {}, meta: before.meta }),
    appendDeltaLog: () => assert.fail('empty ticks must not open the delta log'),
  });
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/empty.json',
      '--entities',
      'pr',
      '--log',
    ],
    deps,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.logFile, '/tmp/empty.json.deltalog.ndjson');
  assert.deepEqual(deps.events, ['snapshot']);
});

test('producer append failure is io and leaves snapshot publication untouched', () => {
  const deps = producerDeps({
    appendDeltaLog: () => {
      throw new Error('disk full');
    },
  });
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/state.json',
      '--entities',
      'pr',
      '--log',
    ],
    deps,
  );
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'io');
  assert.deepEqual(deps.events, []);
});

test('lock loss from the append fence maps to busy and skips snapshot publication', () => {
  const deps = producerDeps({
    appendDeltaLog(_file, _payload, appendDeps) {
      assert.equal(typeof appendDeps.onProgress, 'function');
      assert.equal(typeof appendDeps.verifyBeforeMutation, 'function');
      appendDeps.onProgress();
      const error = new Error('lost');
      error.code = 'LOCK_LOST';
      throw error;
    },
  });
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/state.json',
      '--entities',
      'pr',
      '--log',
    ],
    deps,
  );
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'busy');
  assert.deepEqual(deps.events, []);
});

test('read re-delivers without advance, filters by number, and advance records the scanned tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-read-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [
      { id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] },
      { id: 'b'.repeat(64), entity: 'pr', number: 7, title: 'b', classes: ['ci-changed'] },
    ],
    repo: 'o/r',
    monitorId: 'm',
  });
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  const first = run(['read', '--cursor', cursor, '--number', '42'], {
    now: () => '2026-09-20T12:05:00.000Z',
  });
  assert.equal(first.code, 10);
  assert.deepEqual(first.report.cursor, { path: cursor, from: 0, to: 2, advanced: false });
  assert.equal(first.report.deltas.length, 1);
  const repeated = run(['read', '--cursor', cursor, '--number', '42'], {
    now: () => '2026-09-20T12:05:00.000Z',
  });
  assert.equal(repeated.report.deltas.length, 1);
  const advanced = run(['read', '--cursor', cursor, '--only-classes', 'missing', '--advance'], {
    now: () => '2026-09-20T12:05:00.000Z',
  });
  assert.equal(advanced.code, 0);
  assert.equal(advanced.report.cursor.advanced, true);
  assert.equal(readDeltaLog(log, { afterSeq: 0 }).lastSeq, 2);
  assert.equal(
    run(['read', '--cursor', cursor], { now: () => '2026-09-20T12:05:00.000Z' }).report.deltas
      .length,
    0,
  );
});

test('same-cursor advance contender is busy before read, delivery, or rewind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cursor-advance-lock-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [
      { id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] },
      { id: 'b'.repeat(64), entity: 'pr', number: 7, title: 'b', classes: ['ci-changed'] },
    ],
    repo: 'o/r',
    monitorId: 'm',
  });
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  let nested;
  let reads = 0;
  let writes = 0;
  const deps = {
    now: () => '2026-09-20T12:05:00.000Z',
    readCursor(path) {
      reads++;
      return readCursor(path);
    },
    readDeltaLog(file, options) {
      if (!nested) nested = run(['read', '--cursor', cursor, '--advance'], deps);
      return readDeltaLog(file, options);
    },
    setCursorAtomic(path, value) {
      writes++;
      return setCursorAtomic(path, value);
    },
  };
  const outer = run(['read', '--cursor', cursor, '--advance'], deps);
  assert.equal(outer.code, 10);
  assert.equal(nested.code, 1);
  assert.equal(nested.report.kind, 'busy');
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(readCursor(cursor).seq, 2);
});

test('cursor set contends with an advancing reader and non-advancing reads stay lock-free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cursor-set-lock-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  let nested;
  const deps = {
    now: () => '2026-09-20T12:05:00.000Z',
    readDeltaLog(file, options) {
      if (!nested) nested = run(['cursor', 'set', cursor, '0'], deps);
      return readDeltaLog(file, options);
    },
  };
  assert.equal(run(['read', '--cursor', cursor, '--advance'], deps).code, 10);
  assert.equal(nested.report.kind, 'busy');
  assert.equal(readCursor(cursor).seq, 1);
  assert.equal(
    run(['read', '--cursor', cursor], {
      acquireLock: () => assert.fail('non-advance read must not lock'),
      now: () => '2026-09-20T12:05:00.000Z',
    }).code,
    0,
  );
});

test('advance lock loss before cursor replacement is busy, preserves bytes, and releases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cursor-loss-lock-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  const beforeBytes = readFileSync(cursor);
  let released = 0;
  const result = run(['read', '--cursor', cursor, '--advance'], {
    acquireLock: () => ({ ok: true, token: 'owned' }),
    assertLockOwned: () => false,
    extendLockDeadline: () => ({ ok: false }),
    releaseLock: () => {
      released++;
      return { ok: true };
    },
    now: () => '2026-09-20T12:05:00.000Z',
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'busy');
  assert.deepEqual(readFileSync(cursor), beforeBytes);
  assert.equal(released, 1);
});

test('cursor set bootstraps, accepts replay, and rejects above the complete log tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cursor-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] }],
    repo: 'o/r',
    monitorId: 'm',
  });
  assert.equal(
    run(['cursor', 'set', cursor, '1', '--log-file', log], {
      now: () => '2026-09-20T12:05:00.000Z',
    }).code,
    0,
  );
  assert.equal(
    run(['cursor', 'set', cursor, '0'], { now: () => '2026-09-20T12:05:00.000Z' }).report.cursor.to,
    0,
  );
  const tooHigh = run(['cursor', 'set', cursor, '2'], { now: () => '2026-09-20T12:05:00.000Z' });
  assert.equal(tooHigh.code, 2);
  assert.equal(tooHigh.report.kind, 'log');
});

test('read and cursor commands render their own safe text reports', async () => {
  const output = await runCommand(
    ['read', '--cursor', '/missing.cursor.json', '--format', 'text'],
    {
      now: () => '2026-09-20T12:05:00.000Z',
    },
  );
  assert.match(output.output, /read error/);
});
