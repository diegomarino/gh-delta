// Fingerprint tests: stable, legible rows prevent phantom deltas from API
// ordering noise. Schema v2 (R2) dropped the opaque ci/reviews/threadDigest
// digests -- checks/reviews/threads are now the sole, sorted, compared
// representation, and they enter delta.id directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChecks,
  buildReviews,
  buildThreads,
  deltaId,
  prFingerprint,
  issueFingerprint,
} from '../lib/fingerprint.mjs';

test('buildChecks sorts deterministically regardless of input order', () => {
  const a = { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' };
  const b = { name: 'lint', kind: 'check', status: 'completed', conclusion: 'failure' };
  const c = { name: 'ci/circleci', kind: 'status', status: 'success', conclusion: 'success' };
  assert.deepEqual(buildChecks([a, b, c]), buildChecks([c, a, b]));
  assert.deepEqual(buildChecks([b, c, a]), buildChecks([a, b, c]));
});

test('buildChecks changes when a conclusion changes', () => {
  const before = [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }];
  const after = [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }];
  assert.notDeepEqual(buildChecks(before), buildChecks(after));
});

test('buildChecks defaults an absent list to []', () => {
  assert.deepEqual(buildChecks(), []);
  assert.deepEqual(buildChecks([]), []);
});

test('buildReviews sorts deterministically regardless of input order', () => {
  const rows = [
    {
      id: 'PRR_2',
      author: 'bob',
      state: 'commented',
      submittedAt: '2026-07-01T11:00:00Z',
      commit: 'c2',
    },
    {
      id: 'PRR_1',
      author: 'alice',
      state: 'approved',
      submittedAt: '2026-07-01T10:00:00Z',
      commit: 'c1',
    },
  ];
  assert.deepEqual(buildReviews(rows), buildReviews([rows[1], rows[0]]));
  assert.deepEqual(buildReviews(rows), [
    {
      id: 'PRR_1',
      author: 'alice',
      state: 'approved',
      submittedAt: '2026-07-01T10:00:00Z',
      commit: 'c1',
    },
    {
      id: 'PRR_2',
      author: 'bob',
      state: 'commented',
      submittedAt: '2026-07-01T11:00:00Z',
      commit: 'c2',
    },
  ]);
});

test('buildReviews changes for a new review with the same author and state', () => {
  const before = [
    {
      id: 'PRR_1',
      author: 'alice',
      state: 'commented',
      submittedAt: '2026-07-01T10:00:00Z',
      commit: 'c1',
    },
  ];
  const after = [
    {
      id: 'PRR_2',
      author: 'alice',
      state: 'commented',
      submittedAt: '2026-07-01T11:00:00Z',
      commit: 'c1',
    },
  ];
  assert.notDeepEqual(buildReviews(before), buildReviews(after));
});

test('buildThreads sorts deterministically regardless of input order and drops id-less rows', () => {
  const nodes = [
    { id: 'T_B', resolved: true, comments: 1 },
    { id: 'T_A', resolved: false, comments: 2 },
    { resolved: true, comments: 0 }, // no id: dropped
  ];
  assert.deepEqual(buildThreads(nodes), [
    { id: 'T_A', resolved: false, comments: 2 },
    { id: 'T_B', resolved: true, comments: 1 },
  ]);
  assert.deepEqual(buildThreads([nodes[1], nodes[0], nodes[2]]), buildThreads(nodes));
  assert.deepEqual(buildThreads(), []);
});

test('buildThreads changes when a resolution state flips', () => {
  const one = [
    { id: 'T_A', resolved: false },
    { id: 'T_B', resolved: true },
  ];
  const flipped = [
    { id: 'T_A', resolved: true },
    { id: 'T_B', resolved: true },
  ];
  assert.notDeepEqual(buildThreads(one), buildThreads(flipped));
});

// --- determinism: the load-bearing invariant ---------------------------------
// checks/reviews/threads enter delta.id directly (via deltaIdentity's `to`).
// Before R2 this invariant only protected an opaque digest; a sort regression
// here now silently changes every delta id GitHub's own pagination order
// happens to shuffle differently between ticks.

test('shuffling the order GitHub returns checks/reviews/threads yields an identical fingerprint and delta id', () => {
  const checks = [
    { name: 'build', kind: 'check', status: 'completed', conclusion: 'success', detailsUrl: null },
    {
      name: 'lint',
      kind: 'check',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://x/1',
    },
    {
      name: 'ci/circleci',
      kind: 'status',
      status: 'success',
      conclusion: 'success',
      detailsUrl: null,
    },
  ];
  const reviews = [
    {
      id: 'PRR_1',
      author: 'alice',
      state: 'approved',
      submittedAt: '2026-07-01T10:00:00Z',
      commit: 'c1',
    },
    {
      id: 'PRR_2',
      author: 'bob',
      state: 'commented',
      submittedAt: '2026-07-01T11:00:00Z',
      commit: 'c2',
    },
    {
      id: 'PRR_3',
      author: 'alice',
      state: 'commented',
      submittedAt: '2026-07-01T12:00:00Z',
      commit: 'c3',
    },
  ];
  const threads = [
    { id: 'T_A', resolved: false, comments: 1 },
    { id: 'T_B', resolved: true, comments: 2 },
    { id: 'T_C', resolved: false, comments: 0 },
  ];
  const basePr = {
    state: 'open',
    updatedAt: '2026-07-01T12:05:00Z',
    isDraft: false,
    headSha: 'd0c5',
    baseRef: 'main',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'review_required',
    comments: 5,
    conversationComments: 5,
    recentComments: [{ id: 'IC_1', author: 'alice' }],
    labels: [{ name: 'a' }],
    assignees: ['zoe'],
    reviewRequests: ['bob'],
  };

  const canonical = prFingerprint({ ...basePr, checks, reviews, threads });
  const canonicalId = deltaId({ repo: 'owner/repo', entity: 'pr', number: 1, to: canonical });

  const shuffles = [
    {
      checks: [checks[2], checks[0], checks[1]],
      reviews: [reviews[1], reviews[2], reviews[0]],
      threads: [threads[2], threads[0], threads[1]],
    },
    {
      checks: [checks[1], checks[2], checks[0]],
      reviews: [reviews[2], reviews[0], reviews[1]],
      threads: [threads[1], threads[2], threads[0]],
    },
  ];
  for (const shuffled of shuffles) {
    const fp = prFingerprint({ ...basePr, ...shuffled });
    assert.deepEqual(fp, canonical);
    const id = deltaId({ repo: 'owner/repo', entity: 'pr', number: 1, to: fp });
    assert.equal(id, canonicalId);
  }
});

// --- prFingerprint / issueFingerprint ----------------------------------------

test('prFingerprint carries mergeStateStatus, checks, and reviews directly (no drop-list)', () => {
  // Schema v2: `fingerprint` is exactly the compared fields, with nothing
  // stripped before hashing or comparison -- there is no drop-list anymore.
  const fp = prFingerprint({
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    mergeStateStatus: 'blocked',
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviews: [{ id: 'PRR_1', author: 'alice', state: 'approved' }],
  });
  assert.equal(fp.mergeStateStatus, 'blocked');
  assert.ok('checks' in fp);
  assert.ok('reviews' in fp);
});

test('prFingerprint extracts the tracked fields', () => {
  const pr = {
    number: 42,
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    isDraft: false,
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviewDecision: 'approved',
    reviews: [{ id: 'PRR_1', author: 'alice', state: 'approved', submittedAt: '', commit: '' }],
    mergeable: 'mergeable',
    comments: 3,
    headSha: 'abc123',
  };
  const fp = prFingerprint(pr);
  assert.equal(fp.state, 'open');
  assert.equal(fp.isDraft, false);
  assert.equal(fp.reviewDecision, 'approved');
  assert.equal(fp.mergeable, 'mergeable');
  assert.equal(fp.comments, 3);
  assert.equal(fp.headSha, 'abc123');
  assert.deepEqual(fp.checks, [
    { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
  ]);
  assert.deepEqual(fp.reviews, [
    { id: 'PRR_1', author: 'alice', state: 'approved', submittedAt: '', commit: '' },
  ]);
});

test('prFingerprint sorts labels, assignees, and reviewRequests, and stores the base ref', () => {
  const fp = prFingerprint({
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    baseRef: 'main',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    assignees: ['zoe', 'alice'],
    reviewRequests: ['org/platform-team', 'bob'],
  });
  assert.equal(fp.baseRef, 'main');
  assert.deepEqual(fp.labels, ['backend', 'worker']);
  assert.deepEqual(fp.assignees, ['alice', 'zoe']);
  assert.deepEqual(fp.reviewRequests, ['bob', 'org/platform-team']);
});

test('prFingerprint defaults the compared list/enum fields when input omits them', () => {
  const fp = prFingerprint({ state: 'open', updatedAt: '2026-07-01T10:00:00Z' });
  assert.equal(fp.baseRef, '');
  assert.equal(fp.mergeable, 'unknown');
  assert.equal(fp.mergeStateStatus, 'unknown');
  assert.equal(fp.reviewDecision, 'none');
  assert.deepEqual(fp.labels, []);
  assert.deepEqual(fp.assignees, []);
  assert.deepEqual(fp.reviewRequests, []);
  assert.deepEqual(fp.checks, []);
  assert.deepEqual(fp.reviews, []);
  assert.deepEqual(fp.threads, []);
  assert.deepEqual(fp.recentComments, []);
});

test('issueFingerprint sorts assignees', () => {
  const fp = issueFingerprint({
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    assignees: ['zoe', 'alice'],
    comments: 0,
  });
  assert.deepEqual(fp.assignees, ['alice', 'zoe']);
});

test('prFingerprint reads exact totals beyond the old 100 cap', () => {
  const fp = prFingerprint({
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    comments: 347,
  });
  assert.equal(fp.comments, 347);
});

test('issueFingerprint sorts labels and counts comments', () => {
  const issue = {
    number: 7,
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: 2,
  };
  const fp = issueFingerprint(issue);
  assert.deepEqual(fp.labels, ['backend', 'worker']);
  assert.equal(fp.comments, 2);
});

// deltaId / no-drop-list guarantee ------------------------------------------

test('deltaId over a fingerprint with extra injected keys differs from the id of the clean fingerprint', () => {
  // Proves there is no silent dropping anymore: any key present in the
  // fingerprint that feeds deltaIdentity changes the hash. (See
  // lib/fingerprint.mjs's deltaIdentity, which hashes `to.fingerprint` /
  // `from.fingerprint` directly -- no comparableFingerprint filter.)
  const clean = { state: 'open', checks: [] };
  const injected = { ...clean, unexpectedExtra: 'sneaky' };
  const identityFor = (fp) => ({ repo: 'owner/repo', entity: 'pr', number: 1, to: fp });
  assert.notEqual(deltaId(identityFor(clean)), deltaId(identityFor(injected)));
});
