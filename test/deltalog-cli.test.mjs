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
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { appendDeltaLog, readDeltaLog, setCursorAtomic } from '../lib/deltalog.mjs';

const before = {
  pr: {
    42: {
      state: 'OPEN',
      updatedAt: '2026-09-20T10:00:00Z',
      isDraft: false,
      ci: 'a',
      review: 'REVIEW_REQUIRED',
      reviews: 'a',
      mergeable: 'UNKNOWN',
      comments: 0,
      commentsOverflow: false,
      head: 'one',
    },
  },
  issue: {},
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

function producerDeps(overrides = {}) {
  const events = [];
  return {
    ...lock,
    fetchPRs: () => [pr],
    fetchIssues: () => [],
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

test('cursor set bootstraps, accepts replay, and rejects above the complete log tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cursor-'));
  const log = join(dir, 'events.ndjson');
  const cursor = join(dir, 'worker.cursor.json');
  appendDeltaLog(log, {
    detectedAt: '2026-09-20T12:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'a', classes: ['new'] }],
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
