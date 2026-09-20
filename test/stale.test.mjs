import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltas } from '../lib/detect.mjs';
import { deltaId, deltaIdentity } from '../lib/fingerprint.mjs';
import { run } from '../lib/cli.mjs';

const pr = {
  number: 42,
  title: 'quiet',
  state: 'OPEN',
  updatedAt: '2026-09-18T00:00:00.000Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: null,
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'abc',
};

const DAY = 24 * 60 * 60 * 1000;

test('stale emits at the threshold once per UTC day with period-specific ids', () => {
  const seeded = detectDeltas(
    null,
    { pr: [pr], issue: [] },
    { at: '2026-09-18T00:00:00.000Z', staleAfterMs: DAY },
  );
  const beforeThreshold = detectDeltas(
    seeded.snapshot,
    { pr: [pr], issue: [] },
    { at: '2026-09-18T23:59:59.999Z', staleAfterMs: DAY },
  );
  assert.deepEqual(beforeThreshold.deltas, []);
  const first = detectDeltas(
    beforeThreshold.snapshot,
    { pr: [pr], issue: [] },
    {
      at: '2026-09-19T00:00:00.000Z',
      staleAfterMs: DAY,
    },
  );
  assert.deepEqual(
    first.deltas.map((delta) => delta.classes),
    [['stale']],
  );
  assert.equal(first.deltas[0].staleAt, '2026-09-19');
  const repeated = detectDeltas(
    first.snapshot,
    { pr: [pr], issue: [] },
    {
      at: '2026-09-19T23:59:59.000Z',
      staleAfterMs: DAY,
    },
  );
  assert.deepEqual(repeated.deltas, []);
  const nextDay = detectDeltas(
    repeated.snapshot,
    { pr: [pr], issue: [] },
    { at: '2026-09-20T00:00:00.000Z', staleAfterMs: DAY },
  );
  assert.equal(nextDay.deltas[0].staleAt, '2026-09-20');
  assert.notEqual(
    deltaId(deltaIdentity('o/r', first.deltas[0])),
    deltaId(deltaIdentity('o/r', nextDay.deltas[0])),
  );
  const changed = detectDeltas(
    nextDay.snapshot,
    { pr: [{ ...pr, title: 'changed', updatedAt: '2026-09-20T03:00:00.000Z' }], issue: [] },
    {
      at: '2026-09-20T03:00:00.000Z',
      staleAfterMs: DAY,
    },
  );
  assert.equal(changed.snapshot.pr[42].staleEmittedFor, undefined);
});

test('stale day is derived from the parsed instant in UTC', () => {
  const seeded = detectDeltas(
    null,
    { pr: [pr], issue: [] },
    { at: '2026-09-18T00:00:00.000Z', staleAfterMs: 1 },
  );
  const result = detectDeltas(
    seeded.snapshot,
    { pr: [pr], issue: [] },
    { at: '2026-09-20T00:30:00+02:00', staleAfterMs: 1 },
  );
  assert.equal(result.deltas[0].staleAt, '2026-09-19');
});

test('stale opt-in converges a legacy snapshot without changing no-flag snapshots', () => {
  const legacy = detectDeltas(null, { pr: [pr], issue: [] });
  assert.equal(legacy.snapshot.pr[42].lastChangedAt, undefined);
  assert.equal(legacy.snapshot.pr[42].ticksSinceChange, undefined);
  const converged = detectDeltas(
    legacy.snapshot,
    { pr: [pr], issue: [] },
    { at: '2026-09-20T00:00:00.000Z', staleAfterMs: DAY },
  );
  assert.equal(converged.snapshot.pr[42].lastChangedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(converged.snapshot.pr[42].ticksSinceChange, 0);
  assert.deepEqual(converged.deltas, []);
});

test('stale rejects an invalid persisted lastChangedAt', () => {
  assert.throws(
    () =>
      detectDeltas(
        {
          pr: {
            42: {
              ...detectDeltas(null, { pr: [pr], issue: [] }).snapshot.pr[42],
              lastChangedAt: 'nope',
            },
          },
          issue: {},
        },
        { pr: [pr], issue: [] },
        { at: '2026-09-20T00:00:00.000Z', staleAfterMs: DAY },
      ),
    /invalid persisted lastChangedAt/,
  );
});

test('CLI validates --stale-after before GitHub access', () => {
  const result = run(['--repo', 'o/r', '--state-file', '/tmp/stale.json', '--stale-after', '0h'], {
    fetchPRs: () => assert.fail('invalid duration must not fetch'),
    fetchIssues: () => assert.fail('invalid duration must not fetch'),
    now: () => '2026-09-20T00:00:00.000Z',
  });
  assert.equal(result.code, 2);
  assert.equal(result.report.kind, 'config');
  assert.match(result.report.error, /^--stale-after must be a positive integer/);
});

test('CLI --detail exposes staleAt through the stale detail contract', () => {
  const seeded = detectDeltas(
    null,
    { pr: [pr], issue: [] },
    { at: '2026-09-18T00:00:00.000Z', staleAfterMs: DAY },
  ).snapshot;
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/stale.json', '--stale-after', '1h', '--detail'],
    {
      acquireLock: () => ({ ok: true, token: 'lock' }),
      assertLockOwned: () => true,
      releaseLock: () => {},
      readSnapshot: () => seeded,
      writeSnapshotAtomic: () => {},
      fetchPRs: () => [pr],
      fetchIssues: () => [],
      now: () => '2026-09-20T00:00:00.000Z',
    },
  );
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].details, [
    { class: 'stale', field: 'staleAt', from: null, to: '2026-09-20' },
  ]);
});
