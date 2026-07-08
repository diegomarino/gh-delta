// headRefName tests: PR deltas carry the head branch name as contextual
// metadata (symmetric with title), it never enters change detection, issues
// never carry it, and a deleted head branch (null from GitHub) is emitted as
// null rather than throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltas } from '../lib/detect.mjs';
import { buildOutpostPayload } from '../lib/outpost.mjs';

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
  headRefName: 'feature/widget',
  ...over,
});

const issue = (over = {}) => ({
  number: 7,
  title: 'bug',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  labels: [],
  comments: 0,
  ...over,
});

test('a PR delta carries headRefName equal to the PR head branch', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ headRefName: 'feature/login' })], issue: [] });
  assert.equal(r.deltas[0].headRefName, 'feature/login');
});

test('renaming ONLY the head branch does not, by itself, produce a delta', () => {
  const base = detectDeltas(null, { pr: [pr({ headRefName: 'feature/a' })], issue: [] });
  // Same everything, only the branch name differs — proves it is not fingerprinted.
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ headRefName: 'feature/a-renamed' })],
    issue: [],
  });
  assert.deepEqual(r.deltas, []);
});

test('an issue delta never carries headRefName', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [issue()] });
  assert.equal(r.deltas[0].entity, 'issue');
  assert.equal('headRefName' in r.deltas[0], false);
});

test('a PR whose head branch was deleted emits headRefName: null without error', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ headRefName: null })], issue: [] });
  assert.equal(r.deltas[0].headRefName, null);
  assert.equal('headRefName' in r.deltas[0], true); // present, just null
});

test('headRefName is present across families with a current object, absent on missing', () => {
  // new
  const seed = detectDeltas(null, { pr: [], issue: [] });
  const created = detectDeltas(seed.snapshot, { pr: [pr({ headRefName: 'b/new' })], issue: [] });
  assert.deepEqual(created.deltas[0].classes, ['new']);
  assert.equal(created.deltas[0].headRefName, 'b/new');

  // updated (bare updatedAt bump)
  const base = detectDeltas(null, { pr: [pr({ headRefName: 'b/u' })], issue: [] });
  const updated = detectDeltas(base.snapshot, {
    pr: [pr({ headRefName: 'b/u', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(updated.deltas[0].classes, ['updated']);
  assert.equal(updated.deltas[0].headRefName, 'b/u');

  // ci-changed
  const ciChanged = detectDeltas(base.snapshot, {
    pr: [
      pr({
        headRefName: 'b/u',
        updatedAt: '2026-07-01T11:00:00Z',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
    ],
    issue: [],
  });
  assert.ok(ciChanged.deltas[0].classes.includes('ci-changed'));
  assert.equal(ciChanged.deltas[0].headRefName, 'b/u');

  // reappeared
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(missing.deltas[0].classes, ['missing']);
  assert.equal('headRefName' in missing.deltas[0], false); // no current object → absent
  const back = detectDeltas(missing.snapshot, { pr: [pr({ headRefName: 'b/u' })], issue: [] });
  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.deltas[0].headRefName, 'b/u');
});

test('the outpost payload mirrors the report delta for headRefName', () => {
  const report = { repo: 'o/r', monitorId: 'm', at: '2026-07-01T12:00:00Z' };
  // PR with a current object → carries the branch (or null if deleted post-merge).
  const change = {
    entity: 'pr',
    number: 42,
    title: 'x',
    headRefName: 'feature/z',
    classes: ['merged'],
    from: { state: 'OPEN' },
    to: { state: 'MERGED' },
  };
  // Missing-family PR has NO current object; the report delta omits headRefName,
  // so the payload must omit it too (never fabricate a null).
  const missing = {
    entity: 'pr',
    number: 42,
    title: '(missing from current fetch)',
    classes: ['missing'],
    missingTicks: 1,
    from: { state: 'OPEN' },
    to: null,
  };
  const issueDelta = {
    entity: 'issue',
    number: 7,
    title: 'bug',
    classes: ['relabeled'],
    from: {},
    to: { labels: ['x'] },
  };
  assert.equal(buildOutpostPayload({ report, delta: change }).headRefName, 'feature/z');
  assert.equal('headRefName' in buildOutpostPayload({ report, delta: missing }), false);
  assert.equal('headRefName' in buildOutpostPayload({ report, delta: issueDelta }), false);
});

test('headRefName is absent on presumed-deleted (no current object)', () => {
  let s = detectDeltas(null, { pr: [pr()], issue: [] }).snapshot;
  const t1 = detectDeltas(s, { pr: [], issue: [] });
  const t2 = detectDeltas(t1.snapshot, { pr: [], issue: [] });
  const t3 = detectDeltas(t2.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t3.deltas[0].classes, ['presumed-deleted']);
  assert.equal('headRefName' in t3.deltas[0], false);
});
