// Fingerprint tests: stable hashes prevent phantom deltas from API ordering noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeCiRollup,
  deltaId,
  hashReviews,
  hashReviewThreads,
  prFingerprint,
  issueFingerprint,
  summarizeCiRollup,
  summarizeReviews,
  summarizeReviewThreads,
} from '../lib/fingerprint.mjs';

test('canonicalizeCiRollup is order-independent', () => {
  const a = [
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  const b = [a[1], a[0]]; // reversed
  assert.equal(canonicalizeCiRollup(a), canonicalizeCiRollup(b));
});

test('canonicalizeCiRollup changes when a conclusion changes', () => {
  const before = [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const after = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.notEqual(canonicalizeCiRollup(before), canonicalizeCiRollup(after));
});

test('canonicalizeCiRollup handles StatusContext shape (context/state)', () => {
  const rollup = [{ context: 'ci/circleci', state: 'SUCCESS' }];
  assert.equal(typeof canonicalizeCiRollup(rollup), 'string');
});

test('summarizeCiRollup normalizes both rollup shapes into sorted named rows', () => {
  const rollup = [
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { context: 'ci/circleci', state: 'SUCCESS' },
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  assert.deepEqual(summarizeCiRollup(rollup), [
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'ci/circleci', status: 'SUCCESS', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
  ]);
  assert.deepEqual(summarizeCiRollup(), []);
});

test('canonicalizeCiRollup digests are frozen across the summary refactor', () => {
  // Digests persisted by pre-summary snapshots; a change here would emit a
  // phantom ci-changed delta for every PR on upgrade.
  assert.equal(canonicalizeCiRollup([]), 'da39a3ee5e6b');
  assert.equal(
    canonicalizeCiRollup([{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
    '53d176557e2f',
  );
});

test('summarizeReviews extracts compact sorted author/state rows', () => {
  const reviews = [
    {
      id: 'r2',
      submittedAt: '2026-07-01T11:00:00Z',
      author: { login: 'bob' },
      state: 'COMMENTED',
      commit: { oid: 'c2' },
    },
    {
      id: 'r1',
      submittedAt: '2026-07-01T10:00:00Z',
      author: { login: 'alice' },
      state: 'APPROVED',
      commit: { oid: 'c1' },
    },
  ];
  assert.deepEqual(summarizeReviews(reviews), [
    { author: 'alice', state: 'APPROVED', submittedAt: '2026-07-01T10:00:00Z', commit: 'c1' },
    { author: 'bob', state: 'COMMENTED', submittedAt: '2026-07-01T11:00:00Z', commit: 'c2' },
  ]);
  assert.deepEqual(summarizeReviews(), []);
});

test('prFingerprint carries mergeStateStatus, ciChecks, and reviewSummary directly (no drop-list)', () => {
  // Schema v2: `fingerprint` is exactly the compared fields, with nothing
  // stripped before hashing or comparison -- there is no drop-list anymore.
  const fp = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
  });
  assert.equal(fp.mergeStateStatus, 'BLOCKED');
  assert.ok('ciChecks' in fp);
  assert.ok('reviewSummary' in fp);
});

test('hashReviews is order-independent and reflects state', () => {
  const one = [
    { author: { login: 'alice' }, state: 'APPROVED' },
    { author: { login: 'bob' }, state: 'COMMENTED' },
  ];
  const rev = [one[1], one[0]];
  assert.equal(hashReviews(one), hashReviews(rev));
  const changed = [
    { author: { login: 'alice' }, state: 'CHANGES_REQUESTED' },
    { author: { login: 'bob' }, state: 'COMMENTED' },
  ];
  assert.notEqual(hashReviews(one), hashReviews(changed));
});

test('hashReviews changes for a new review with same author and state', () => {
  const before = [
    {
      id: 'r1',
      submittedAt: '2026-07-01T10:00:00Z',
      author: { login: 'alice' },
      state: 'COMMENTED',
    },
  ];
  const after = [
    {
      id: 'r2',
      submittedAt: '2026-07-01T11:00:00Z',
      author: { login: 'alice' },
      state: 'COMMENTED',
    },
  ];
  assert.notEqual(hashReviews(before), hashReviews(after));
});

test('prFingerprint extracts the tracked fields', () => {
  const pr = {
    number: 42,
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    isDraft: false,
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviewDecision: 'APPROVED',
    latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
    mergeable: 'MERGEABLE',
    totalCommentsCount: 3,
    reviewThreads: 5,
    unresolvedReviewThreads: 2,
    headRefOid: 'abc123',
  };
  const fp = prFingerprint(pr);
  assert.equal(fp.state, 'OPEN');
  assert.equal(fp.isDraft, false);
  assert.equal(fp.review, 'APPROVED');
  assert.equal(fp.mergeable, 'MERGEABLE');
  assert.equal(fp.comments, 3);
  assert.equal('commentsOverflow' in fp, false);
  assert.equal(fp.reviewThreads, 5);
  assert.equal(fp.unresolvedReviewThreads, 2);
  assert.equal(fp.head, 'abc123');
  assert.equal(typeof fp.ci, 'string');
  assert.deepEqual(fp.ciChecks, [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
  assert.deepEqual(fp.reviewSummary, [
    { author: 'alice', state: 'APPROVED', submittedAt: '', commit: '' },
  ]);
});

test('prFingerprint sorts labels, assignees, and reviewRequests, and stores the base ref', () => {
  const fp = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    baseRefName: 'main',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    assignees: ['zoe', 'alice'],
    reviewRequests: ['org/platform-team', 'bob'],
  });
  assert.equal(fp.base, 'main');
  assert.deepEqual(fp.labels, ['backend', 'worker']);
  assert.deepEqual(fp.assignees, ['alice', 'zoe']);
  assert.deepEqual(fp.reviewRequests, ['bob', 'org/platform-team']);
});

test('prFingerprint defaults the compared list/enum fields when input omits them', () => {
  const fp = prFingerprint({ state: 'OPEN', updatedAt: '2026-07-01T10:00:00Z' });
  assert.equal(fp.base, '');
  assert.deepEqual(fp.labels, []);
  assert.deepEqual(fp.assignees, []);
  assert.deepEqual(fp.reviewRequests, []);
});

test('summarizeReviewThreads sorts by id and normalizes isResolved, dropping id-less rows', () => {
  const nodes = [
    { id: 'T_B', isResolved: true },
    { id: 'T_A', isResolved: false },
    { isResolved: true }, // no id: dropped
  ];
  assert.deepEqual(summarizeReviewThreads(nodes), [
    { id: 'T_A', isResolved: false },
    { id: 'T_B', isResolved: true },
  ]);
  assert.deepEqual(summarizeReviewThreads(), []);
});

test('hashReviewThreads is order-independent and reflects a resolution-state change', () => {
  const one = [
    { id: 'T_A', isResolved: false },
    { id: 'T_B', isResolved: true },
  ];
  const reordered = [one[1], one[0]];
  assert.equal(hashReviewThreads(one), hashReviewThreads(reordered));
  const flipped = [
    { id: 'T_A', isResolved: true },
    { id: 'T_B', isResolved: true },
  ];
  assert.notEqual(hashReviewThreads(one), hashReviewThreads(flipped));
});

test('prFingerprint always carries threadDigest/threadStates, even with zero threads or no reviewThreadNodes at all', () => {
  // Regression guard: threadDigest/threadStates must be unconditionally
  // present -- never sometimes-present depending on whether the input happens
  // to carry `reviewThreadNodes`. A PR with zero review threads still gets
  // the digest of an empty list and an empty threadStates array; an input
  // that omits `reviewThreadNodes` entirely (predating gh.mjs's field, or a
  // caller building PR-shaped objects by hand) gets exactly the same thing,
  // not an absent key.
  const noThreadsField = prFingerprint({ state: 'OPEN', updatedAt: '2026-07-01T10:00:00Z' });
  assert.equal(typeof noThreadsField.threadDigest, 'string');
  assert.deepEqual(noThreadsField.threadStates, []);

  const emptyThreads = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    reviewThreadNodes: [],
  });
  assert.equal(typeof emptyThreads.threadDigest, 'string');
  assert.deepEqual(emptyThreads.threadStates, []);
  assert.equal(emptyThreads.threadDigest, noThreadsField.threadDigest);
});

test('prFingerprint never omits threadDigest/threadStates keys, regardless of input shape', () => {
  const zeroThreads = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    reviewThreadNodes: [],
  });
  assert.ok(Object.hasOwn(zeroThreads, 'threadDigest'));
  assert.ok(Object.hasOwn(zeroThreads, 'threadStates'));

  const noFieldAtAll = prFingerprint({ state: 'OPEN', updatedAt: '2026-07-01T10:00:00Z' });
  assert.ok(Object.hasOwn(noFieldAtAll, 'threadDigest'));
  assert.ok(Object.hasOwn(noFieldAtAll, 'threadStates'));
});

test('prFingerprint carries threadDigest/threadStates when reviewThreadNodes is present', () => {
  const fp = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    reviewThreadNodes: [{ id: 'T_A', isResolved: false }],
  });
  assert.equal(typeof fp.threadDigest, 'string');
  assert.deepEqual(fp.threadStates, [{ id: 'T_A', isResolved: false }]);
});

test('issueFingerprint sorts assignees', () => {
  const fp = issueFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    assignees: ['zoe', 'alice'],
    comments: 0,
  });
  assert.deepEqual(fp.assignees, ['alice', 'zoe']);
});

test('prFingerprint reads exact totals beyond the old 100 cap', () => {
  const fp = prFingerprint({
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    totalCommentsCount: 347,
  });
  assert.equal(fp.comments, 347);
});

test('issueFingerprint sorts labels and counts comments', () => {
  const issue = {
    number: 7,
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: 2,
  };
  const fp = issueFingerprint(issue);
  assert.deepEqual(fp.labels, ['backend', 'worker']);
  assert.equal(fp.comments, 2);
  assert.equal('commentsOverflow' in fp, false);
});

// deltaId / no-drop-list guarantee ------------------------------------------

test('deltaId over a fingerprint with extra injected keys differs from the id of the clean fingerprint', () => {
  // Proves there is no silent dropping anymore: any key present in the
  // fingerprint that feeds deltaIdentity changes the hash. (See
  // lib/fingerprint.mjs's deltaIdentity, which hashes `to.fingerprint` /
  // `from.fingerprint` directly -- no comparableFingerprint filter.)
  const clean = { state: 'OPEN', ci: 'abc' };
  const injected = { ...clean, unexpectedExtra: 'sneaky' };
  const identityFor = (fp) => ({ repo: 'owner/repo', entity: 'pr', number: 1, to: fp });
  assert.notEqual(deltaId(identityFor(clean)), deltaId(identityFor(injected)));
});
