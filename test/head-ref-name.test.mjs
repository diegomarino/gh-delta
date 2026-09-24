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
  state: 'open',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
  reviewDecision: 'review_required',
  reviews: [],
  mergeable: 'unknown',
  comments: 0,
  threads: [],
  headSha: 'sha1',
  headRefName: 'feature/widget',
  ...over,
});

const issue = (over = {}) => ({
  number: 7,
  title: 'bug',
  state: 'open',
  updatedAt: '2026-07-01T10:00:00Z',
  labels: [],
  comments: 0,
  ...over,
});

test('a PR delta carries headRefName equal to the PR head branch', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ headRefName: 'feature/login' })], issue: [] });
  assert.equal(r.deltas[0].context.headRefName, 'feature/login');
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
  assert.equal('headRefName' in r.deltas[0].context, false);
});

test('a merged PR keeps its head branch name (GitHub retains headRefName after deletion)', () => {
  // GitHub's headRefName is String! and survives the branch being deleted at
  // merge, so a `merged` delta still carries the (now-deleted) branch for routing.
  const base = detectDeltas(null, { pr: [pr({ headRefName: 'feature/x' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ headRefName: 'feature/x', state: 'merged', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('merged'));
  assert.equal(r.deltas[0].context.headRefName, 'feature/x');
});

test('a PR object missing headRefName normalizes to null without throwing (defensive)', () => {
  // headRefName is effectively always present from GitHub; the null path is a
  // defensive guard, not a "branch deleted" signal.
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ headRefName: null })], issue: [] });
  assert.equal(r.deltas[0].context.headRefName, null);
  assert.equal('headRefName' in r.deltas[0].context, true);
});

test('headRefName is present across families with a current object, absent on missing', () => {
  // new
  const seed = detectDeltas(null, { pr: [], issue: [] });
  const created = detectDeltas(seed.snapshot, { pr: [pr({ headRefName: 'b/new' })], issue: [] });
  assert.deepEqual(created.deltas[0].classes, ['new']);
  assert.equal(created.deltas[0].context.headRefName, 'b/new');

  // updated (bare updatedAt bump)
  const base = detectDeltas(null, { pr: [pr({ headRefName: 'b/u' })], issue: [] });
  const updated = detectDeltas(base.snapshot, {
    pr: [pr({ headRefName: 'b/u', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(updated.deltas[0].classes, ['updated']);
  assert.equal(updated.deltas[0].context.headRefName, 'b/u');

  // ci-changed
  const ciChanged = detectDeltas(base.snapshot, {
    pr: [
      pr({
        headRefName: 'b/u',
        updatedAt: '2026-07-01T11:00:00Z',
        checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
      }),
    ],
    issue: [],
  });
  assert.ok(ciChanged.deltas[0].classes.includes('ci-changed'));
  assert.equal(ciChanged.deltas[0].context.headRefName, 'b/u');

  // reappeared
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(missing.deltas[0].classes, ['missing']);
  // The whole last-known context, headRefName and title alike, carries over
  // even with no current object (see lib/detect.mjs's missing lifecycle).
  assert.equal(missing.deltas[0].context.headRefName, 'b/u');
  const back = detectDeltas(missing.snapshot, { pr: [pr({ headRefName: 'b/u' })], issue: [] });
  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.deltas[0].context.headRefName, 'b/u');
});

test('the outpost payload embeds the report delta verbatim, headRefName included exactly as given', () => {
  const report = { repo: 'o/r', monitorId: 'm', detectedAt: '2026-07-01T12:00:00Z' };
  // PR with a current object → carries the branch (or null if deleted post-merge).
  const change = {
    entity: 'pr',
    number: 42,
    context: { title: 'x', headRefName: 'feature/z' },
    classes: ['merged'],
    from: { state: 'open' },
    to: { state: 'merged' },
  };
  // Missing-family PR has NO current object; the report delta omits headRefName --
  // verbatim embedding means the payload must omit it too, never fabricate a null.
  const missing = {
    entity: 'pr',
    number: 42,
    context: { title: null, headRefName: 'feature/z' },
    classes: ['missing'],
    missingTicks: 1,
    from: { state: 'open' },
    to: null,
  };
  const issueDelta = {
    entity: 'issue',
    number: 7,
    context: { title: 'bug' },
    classes: ['relabeled'],
    from: {},
    to: { labels: ['x'] },
  };
  assert.equal(
    buildOutpostPayload({ report, delta: change }).delta.context.headRefName,
    'feature/z',
  );
  assert.equal(
    'headRefName' in buildOutpostPayload({ report, delta: missing }).delta.context,
    true,
  );
  assert.equal(
    'headRefName' in buildOutpostPayload({ report, delta: issueDelta }).delta.context,
    false,
  );
});

test('headRefName and title carry over from the last known context on presumed-deleted', () => {
  let s = detectDeltas(null, { pr: [pr()], issue: [] }).snapshot;
  const t1 = detectDeltas(s, { pr: [], issue: [] });
  const t2 = detectDeltas(t1.snapshot, { pr: [], issue: [] });
  const t3 = detectDeltas(t2.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t3.deltas[0].classes, ['presumed-deleted']);
  assert.equal(t3.deltas[0].context.headRefName, 'feature/widget');
  assert.equal(t3.deltas[0].context.title, 'add widget');
});
