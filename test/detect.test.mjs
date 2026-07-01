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
  comments: [],
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

test('issue label removal emits relabeled', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: [],
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

test('legacy fingerprints without commentsOverflow do not emit an upgrade-only delta', () => {
  const oldSnapshot = detectDeltas(null, { pr: [pr()], issue: [] }).snapshot;
  delete oldSnapshot.pr['42'].commentsOverflow;

  const r = detectDeltas(oldSnapshot, { pr: [pr()], issue: [] });

  assert.deepEqual(r.deltas, []);
});

test('omitted entity collection preserves that side of the snapshot', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: [],
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
  assert.equal(r.deltas[0].to, null);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].missing, true);
});

test('objects still missing emit still-missing after the first missing tick', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const still = detectDeltas(missing.snapshot, { pr: [], issue: [] });
  assert.deepEqual(still.deltas[0].classes, ['still-missing']);
});

test('capped comments plus updatedAt bump emits new-comments instead of updated', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: Array.from({ length: 100 }, () => ({})),
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z' }],
  });
  assert.ok(r.deltas[0].classes.includes('new-comments'));
  assert.ok(!r.deltas[0].classes.includes('updated'));
});
