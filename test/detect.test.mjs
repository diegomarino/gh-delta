// Pure detector tests: each case protects one semantic delta class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltas } from '../lib/detect.mjs';

const pr = (over = {}) => ({
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  totalCommentsCount: 0,
  reviewThreads: 0,
  unresolvedReviewThreads: 0,
  headRefOid: 'sha1',
  ...over,
});

test('first run establishes a baseline with no deltas', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] });
  assert.equal(r.baseline, true);
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
});

test('a brand-new PR after baseline emits `new`', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['new']);
});

test('a first-observed closed PR emits first-seen instead of new', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ state: 'MERGED', updatedAt: '2026-07-01T09:00:00Z' })],
    issue: [],
  });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['first-seen']);
});

test('OPEN → MERGED emits `merged`, not `closed`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('merged'));
  assert.ok(!r.deltas[0].classes.includes('closed'));
});

test('CI FAILURE → SUCCESS + review APPROVED emits ci-changed + review-changed', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        updatedAt: '2026-07-01T11:00:00Z',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        reviewDecision: 'APPROVED',
        latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
      }),
    ],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('ci-changed'));
  assert.ok(r.deltas[0].classes.includes('review-changed'));
});

test('mergeable UNKNOWN → MERGEABLE does NOT emit became-mergeable', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'UNKNOWN' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(!r.deltas[0]?.classes.includes('became-mergeable'));
});

test('mergeable CONFLICTING → MERGEABLE emits became-mergeable', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'CONFLICTING' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('became-mergeable'));
});

test('an identical PR (only array reorder) emits NO delta', () => {
  const base = detectDeltas(null, {
    pr: [
      pr({
        statusCheckRollup: [
          { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    ],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        statusCheckRollup: [
          { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
    ],
    issue: [],
  });
  assert.deepEqual(r.deltas, []);
});

test('draft → ready emits draft-ready', () => {
  const base = detectDeltas(null, { pr: [pr({ isDraft: true })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ isDraft: false, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('draft-ready'));
});

test('new unresolved review threads emit unresolved-threads-added', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 1, unresolvedReviewThreads: 0 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 1, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-added'));
});

test('resolved review threads emit unresolved-threads-resolved', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 2 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 0, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('review thread total changes emit review-threads-changed when unresolved count is stable', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 1, unresolvedReviewThreads: 1 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 1, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['review-threads-changed']);
});

test('issue label removal emits relabeled', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', labels: [{ name: 'backend' }] }],
  });
  assert.ok(r.deltas[0].classes.includes('relabeled'));
});

test('a bare updatedAt bump with no specific signal emits `updated`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['updated']);
});

test('legacy commentsOverflow fingerprints do not emit an upgrade-only delta', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  base.snapshot.pr['42'].commentsOverflow = false;
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] });
  assert.deepEqual(r.deltas, []);
});

test('omitted entity collection preserves that side of the snapshot', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: 0,
  };
  const base = detectDeltas(null, { pr: [pr()], issue: [issue] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })] });
  assert.ok(r.snapshot.issue['7']);
  assert.ok(!r.deltas.some((d) => d.entity === 'issue'));
});

test('objects missing from a fetched collection emit missing and are retained', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].entity, 'pr');
  assert.deepEqual(r.deltas[0].classes, ['missing']);
  assert.equal(r.deltas[0].missingTicks, 1);
  assert.equal(r.deltas[0].to, null);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].missing, true);
});

test('objects still missing emit still-missing after the first missing tick', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const still = detectDeltas(missing.snapshot, { pr: [], issue: [] });
  assert.deepEqual(still.deltas[0].classes, ['still-missing']);
  assert.equal(still.deltas[0].missingTicks, 2);
});

test('a missing object that reappears unchanged emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const back = detectDeltas(missing.snapshot, { pr: [pr()], issue: [] });

  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.deltas[0].from.missing, true);
  assert.equal(back.deltas[0].to.missing, undefined);
  assert.equal(back.snapshot.pr['42'].missing, undefined);
});

test('a missing object that reappears changed emits reappeared plus specific classes', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const back = detectDeltas(missing.snapshot, {
    pr: [
      pr({
        updatedAt: '2026-07-01T11:00:00Z',
        totalCommentsCount: 1,
      }),
    ],
    issue: [],
  });

  assert.ok(back.deltas[0].classes.includes('reappeared'));
  assert.ok(back.deltas[0].classes.includes('new-comments'));
});

test('an exact comment total increase emits new-comments', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: 130,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', comments: 131 }],
  });
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('missing demotes to presumed-deleted on the third absent tick, then goes silent', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const t1 = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t1.deltas[0].classes, ['missing']);
  assert.equal(t1.snapshot.pr['42'].missingTicks, 1);
  const t2 = detectDeltas(t1.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t2.deltas[0].classes, ['still-missing']);
  assert.equal(t2.deltas[0].missingTicks, 2);
  const t3 = detectDeltas(t2.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t3.deltas[0].classes, ['presumed-deleted']);
  assert.equal(t3.deltas[0].missingTicks, 3);
  const t4 = detectDeltas(t3.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t4.deltas, []);
  assert.equal(t4.snapshot.pr['42'].missing, true); // memory intact
});

test('an archived (presumed-deleted) object that reappears emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  let s = base.snapshot;
  for (let i = 0; i < 4; i++) s = detectDeltas(s, { pr: [], issue: [] }).snapshot;
  const back = detectDeltas(s, { pr: [pr()], issue: [] });
  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.snapshot.pr['42'].missingTicks, undefined);
});

test('absent closed items are dormant memory, not missing (incremental scope)', () => {
  const base = detectDeltas(null, { pr: [pr({ state: 'MERGED' })], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].missing, undefined);
});

test('legacy missing fingerprints without missingTicks continue the lifecycle', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const legacy = detectDeltas(base.snapshot, { pr: [], issue: [] }).snapshot;
  delete legacy.pr['42'].missingTicks;
  const r = detectDeltas(legacy, { pr: [], issue: [] });
  assert.deepEqual(r.deltas[0].classes, ['still-missing']);
});
