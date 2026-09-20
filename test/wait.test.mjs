// Bounded worker wait: validate its contract before any detector work begins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../lib/cli.mjs';
import { WAIT_REPORT_FIELDS } from '../lib/contract.mjs';

const prWithGreenCi = {
  number: 42,
  title: 'ready',
  state: 'OPEN',
  updatedAt: '2026-09-21T08:00:00.000Z',
  isDraft: false,
  statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'MERGEABLE',
  comments: [],
  headRefOid: 'abc123',
};

const noopLock = {
  acquireLock: () => ({ ok: true, token: 'test-lock' }),
  assertLockOwned: () => true,
  extendLockDeadline: () => ({ ok: true }),
  releaseLock: () => ({ ok: true }),
};

test('wait without --timeout fails before resolving a repository or fetching GitHub', async () => {
  let resolved = false;
  const result = await runCommand(['wait', '--until', 'ci-changed'], {
    resolveRepo: () => {
      resolved = true;
      return { status: 'found', repo: 'o/r', source: 'git-remote', warnings: [] };
    },
    fetchPRs: () => assert.fail('wait configuration must fail before GitHub fetch'),
    now: () => '2026-09-21T08:00:00.000Z',
  });

  assert.equal(result.code, 2);
  assert.match(result.report.error, /--timeout is required/);
  assert.equal(resolved, false);
});

test('wait evaluates an already-satisfied summary from the first snapshot and touches its heartbeat', async () => {
  let snapshot = null;
  let elapsed = 0;
  const heartbeats = [];
  const result = await runCommand(
    [
      'wait',
      '--repo',
      'o/r',
      '--state-file',
      '/tmp/wait-summary.json',
      '--entities',
      'pr',
      '--timeout',
      '1m',
      '--until-summary',
      'ciRollup=green',
    ],
    {
      ...noopLock,
      fetchPRs: () => [prWithGreenCi],
      fetchIssues: () => [],
      readSnapshot: () => snapshot,
      writeSnapshotAtomic: (_path, next) => {
        snapshot = next;
      },
      touchHeartbeat: (path) => heartbeats.push(path),
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'already-satisfied');
  assert.equal(result.report.iterations, 1);
  assert.equal(result.report.repo, 'o/r');
  assert.ok(result.report.monitorId);
  assert.deepEqual(heartbeats, ['/tmp/wait-summary.json.hb', '/tmp/wait-summary.json.hb']);
});

test('wait --from-log reads the cursor-bound log without invoking GitHub', async () => {
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/worker.cursor.json',
      '--heartbeat-file',
      '/tmp/worker.hb',
      '--until',
      'ci-changed',
      '--timeout',
      '1m',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/worker.deltalog.ndjson', seq: 0 }),
      readDeltaLog: () => ({
        entries: [
          {
            seq: 1,
            delta: { id: 'd1', entity: 'pr', number: 42, title: 'ready', classes: ['ci-changed'] },
          },
        ],
        lastSeq: 1,
        firstSeq: 1,
      }),
      setCursorAtomic: () => {},
      fetchPRs: () => assert.fail('--from-log must not fetch GitHub'),
      fetchIssues: () => assert.fail('--from-log must not fetch GitHub'),
      touchHeartbeat: () => {},
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'until');
  assert.equal(result.report.deltas.length, 1);
});

test('wait releases each detector tick into one accumulated report and heartbeats empty iterations', async () => {
  let snapshot = null;
  let elapsed = 0;
  const heartbeats = [];
  const changed = {
    ...prWithGreenCi,
    updatedAt: '2026-09-21T08:01:00.000Z',
    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }],
  };
  const observations = [[prWithGreenCi], [changed]];
  const result = await runCommand(
    [
      'wait',
      '--repo',
      'o/r',
      '--state-file',
      '/tmp/wait-loop.json',
      '--entities',
      'pr',
      '--timeout',
      '1m',
      '--interval',
      '10s',
      '--until',
      'ci-changed',
    ],
    {
      ...noopLock,
      fetchPRs: () => observations.shift(),
      fetchIssues: () => [],
      readSnapshot: () => snapshot,
      writeSnapshotAtomic: (_path, next) => {
        snapshot = next;
      },
      touchHeartbeat: (path) => heartbeats.push(path),
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'until');
  assert.equal(result.report.iterations, 2);
  assert.equal(result.report.deltas.length, 1);
  assert.deepEqual(heartbeats, [
    '/tmp/wait-loop.json.hb',
    '/tmp/wait-loop.json.hb',
    '/tmp/wait-loop.json.hb',
  ]);
});

test('wait reports a completed tick on stderr and returns its partial report on signal', async () => {
  let snapshot = null;
  const result = await runCommand(
    [
      'wait',
      '--repo',
      'o/r',
      '--state-file',
      '/tmp/wait-signal.json',
      '--entities',
      'pr',
      '--timeout',
      '1m',
      '--until',
      'ci-changed',
      '--progress',
    ],
    {
      ...noopLock,
      fetchPRs: () => [prWithGreenCi],
      fetchIssues: () => [],
      readSnapshot: () => snapshot,
      writeSnapshotAtomic: (_path, next) => {
        snapshot = next;
      },
      touchHeartbeat: () => {},
      isSignaled: () => true,
      handleSignals: false,
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.report.reason, 'signal');
  assert.equal(result.report.iterations, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    type: 'tick',
    at: '2026-09-21T08:00:00.000Z',
    deltas: 0,
  });
});

test('wait keeps polling through settle and streams progress before sleeping', async () => {
  let elapsed = 0;
  const progress = [];
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/settle.cursor.json',
      '--timeout',
      '1m',
      '--interval',
      '10s',
      '--settle',
      '15s',
      '--until',
      'ci-changed',
      '--progress',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/settle.ndjson', seq: 0 }),
      readDeltaLog: (_file, { select }) => {
        const entries = [
          { seq: 1, delta: { id: 'd', entity: 'pr', number: 42, classes: ['ci-changed'] } },
        ];
        return { entries: entries.filter(select), lastSeq: 1, firstSeq: 1 };
      },
      setCursorAtomic: () => {},
      touchHeartbeat: () => {},
      clock: () => elapsed,
      sleep: (milliseconds) => {
        assert.equal(progress.length, elapsed === 0 ? 1 : 2, 'tick progress precedes sleep');
        elapsed += milliseconds;
      },
      onProgress: (line) => progress.push(JSON.parse(line)),
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'until');
  assert.equal(result.report.iterations, 2);
  assert.equal(result.report.deltas.length, 2);
  assert.equal(result.stderr, '');
  assert.equal(progress.length, 2);
});

test('wait from-log derives --until-summary from delta.to rather than a rendered summary', async () => {
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/summary.cursor.json',
      '--timeout',
      '1m',
      '--until-summary',
      'ciRollup=green',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/summary.ndjson', seq: 0 }),
      readDeltaLog: () => ({
        entries: [
          {
            seq: 1,
            delta: {
              id: 'd',
              entity: 'pr',
              number: 42,
              classes: ['updated'],
              summary: { ciRollup: 'failed' },
              to: {
                state: 'OPEN',
                ciChecks: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
              },
            },
          },
        ],
        lastSeq: 1,
        firstSeq: 1,
      }),
      setCursorAtomic: () => {},
      touchHeartbeat: () => {},
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'already-satisfied');
});

test('wait interrupts a settling interval on signal without a further tick', async () => {
  let elapsed = 0;
  let signaled = false;
  let reads = 0;
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/signal-settle.cursor.json',
      '--timeout',
      '1m',
      '--settle',
      '30s',
      '--until',
      'ci-changed',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/signal-settle.ndjson', seq: 0 }),
      readDeltaLog: () => {
        reads++;
        return {
          entries: [
            { seq: 1, delta: { id: 'd', entity: 'pr', number: 42, classes: ['ci-changed'] } },
          ],
          lastSeq: 1,
          firstSeq: 1,
        };
      },
      setCursorAtomic: () => {},
      touchHeartbeat: () => {},
      handleSignals: false,
      isSignaled: () => signaled,
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
        signaled = true;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.reason, 'signal');
  assert.equal(reads, 1);
});

test('wait rejects outpost flags and emits a standard error envelope for a failed tick', async () => {
  const rejected = await runCommand([
    'wait',
    '--timeout',
    '1m',
    '--until',
    'updated',
    '--outpost-url',
    'https://example.com',
  ]);
  assert.equal(rejected.code, 2);
  assert.match(rejected.report.error, /outpost-url/);

  const failed = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/broken.cursor.json',
      '--timeout',
      '1m',
      '--until',
      'updated',
    ],
    {
      readCursor: () => {
        throw Object.assign(new Error('broken cursor'), { kind: 'log' });
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );
  assert.equal(failed.code, 2);
  assert.equal(failed.report.kind, 'log');
  assert.equal(failed.report.reason, undefined);
  assert.equal(failed.report.deltas, undefined);
});

test('wait preserves --number scope for log consumers and catalogs its identity fields', async () => {
  let elapsed = 0;
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/number.cursor.json',
      '--number',
      '7',
      '--timeout',
      '10s',
      '--until',
      'ci-changed',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/number.ndjson', seq: 0 }),
      readDeltaLog: (_file, { select }) => {
        const entries = [
          { seq: 1, delta: { id: 'd', entity: 'pr', number: 42, classes: ['ci-changed'] } },
        ];
        return { entries: entries.filter(select), lastSeq: 1, firstSeq: 1 };
      },
      setCursorAtomic: () => {},
      touchHeartbeat: () => {},
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.report.reason, 'timeout');
  assert.deepEqual(result.report.deltas, []);
  for (const field of ['repo', 'repos', 'monitorId']) assert.ok(WAIT_REPORT_FIELDS.includes(field));
});

test('wait keeps log records for --until-summary when --until names a different class', async () => {
  const result = await runCommand(
    [
      'wait',
      '--from-log',
      '--cursor',
      '/tmp/or.cursor.json',
      '--timeout',
      '1m',
      '--until',
      'ci-changed',
      '--until-summary',
      'isDraft=true',
    ],
    {
      ...noopLock,
      readCursor: () => ({ logFile: '/tmp/or.ndjson', seq: 0 }),
      readDeltaLog: () => ({
        entries: [
          {
            seq: 1,
            delta: {
              id: 'd',
              entity: 'pr',
              number: 42,
              classes: ['updated'],
              to: { state: 'OPEN', isDraft: true, ciChecks: [] },
            },
          },
        ],
        lastSeq: 1,
        firstSeq: 1,
      }),
      setCursorAtomic: () => {},
      touchHeartbeat: () => {},
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );
  assert.equal(result.code, 10);
  assert.equal(result.report.reason, 'already-satisfied');
});

test('wait parses typed summary predicates and rejects invalid typed values', async () => {
  const invalid = await runCommand([
    'wait',
    '--timeout',
    '1m',
    '--until-summary',
    'unresolvedReviewThreads=one',
  ]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.report.error, /non-negative integers/);
});

test('wait creates its derived default heartbeat before an aggregate first tick without undefined snapshot reads', async () => {
  let elapsed = 0;
  const heartbeats = [];
  const result = await runCommand(
    [
      'wait',
      '--repo',
      'a/a,b/b',
      '--state-dir',
      '/tmp/wait-derived',
      '--entities',
      'pr',
      '--timeout',
      '1s',
      '--until-summary',
      'ciRollup=green',
    ],
    {
      ...noopLock,
      fetchPRs: () => [],
      fetchIssues: () => [],
      readSnapshot: (path) => {
        assert.ok(path);
        return null;
      },
      writeSnapshotAtomic: () => {},
      touchHeartbeat: (path) => heartbeats.push(path),
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.reason, 'timeout');
  assert.equal(heartbeats.length, 0, 'aggregate mode has no ambiguous shared heartbeat');
});

test('wait touches the derived normal state heartbeat before its first detector fetch', async () => {
  let elapsed = 0;
  const heartbeats = [];
  const result = await runCommand(
    [
      'wait',
      '--repo',
      'o/r',
      '--state-dir',
      '/tmp/wait-default',
      '--entities',
      'pr',
      '--timeout',
      '1s',
      '--until',
      'ci-changed',
    ],
    {
      ...noopLock,
      fetchPRs: () => {
        assert.equal(heartbeats.length, 1);
        return [];
      },
      fetchIssues: () => [],
      readSnapshot: () => null,
      writeSnapshotAtomic: () => {},
      touchHeartbeat: (path) => heartbeats.push(path),
      clock: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );
  assert.equal(result.code, 0);
  assert.match(heartbeats[0], /repo-o%2Fr__monitor-.*__pr\.json\.hb$/);
});
