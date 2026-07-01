// Fingerprint tests: stable hashes prevent phantom deltas from API ordering noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeCiRollup,
  hashReviews,
  prFingerprint,
  issueFingerprint,
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
    comments: [{}, {}, {}],
    headRefOid: 'abc123',
  };
  const fp = prFingerprint(pr);
  assert.equal(fp.state, 'OPEN');
  assert.equal(fp.isDraft, false);
  assert.equal(fp.review, 'APPROVED');
  assert.equal(fp.mergeable, 'MERGEABLE');
  assert.equal(fp.comments, 3);
  assert.equal(fp.commentsOverflow, false);
  assert.equal(fp.head, 'abc123');
  assert.equal(typeof fp.ci, 'string');
});

test('prFingerprint marks capped comment arrays as overflow', () => {
  const pr = {
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    comments: Array.from({ length: 100 }, () => ({})),
  };
  assert.equal(prFingerprint(pr).commentsOverflow, true);
});

test('issueFingerprint sorts labels and counts comments', () => {
  const issue = {
    number: 7,
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: [{}, {}],
  };
  const fp = issueFingerprint(issue);
  assert.deepEqual(fp.labels, ['backend', 'worker']);
  assert.equal(fp.comments, 2);
  assert.equal(fp.commentsOverflow, false);
});

test('issueFingerprint marks capped comment arrays as overflow', () => {
  const issue = {
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: Array.from({ length: 100 }, () => ({})),
  };
  assert.equal(issueFingerprint(issue).commentsOverflow, true);
});
