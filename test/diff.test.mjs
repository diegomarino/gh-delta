import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFingerprint } from '../lib/diff.mjs';

test('diffFingerprint reports semantic fingerprint changes', () => {
  const from = {
    updatedAt: 'old',
    checks: [{ name: 'lint', kind: 'check', status: 'completed', conclusion: 'failure' }],
    labels: ['a'],
    assignees: ['zoe'],
    reviewRequests: ['team'],
    comments: 1,
  };
  const to = {
    updatedAt: 'new',
    checks: [{ name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' }],
    labels: ['b'],
    assignees: ['alice'],
    reviewRequests: ['team'],
    comments: 2,
  };
  assert.deepEqual(diffFingerprint(from, to), {
    assignees: { added: ['alice'], removed: ['zoe'] },
    checks: { fixed: ['lint'] },
    comments: { from: 1, to: 2 },
    labels: { added: ['b'], removed: ['a'] },
    updatedAt: { from: 'old', to: 'new' },
  });
  assert.equal(from.updatedAt, 'old');
});

test('diffFingerprint caps every array independently', () => {
  const result = diffFingerprint({ labels: [] }, { labels: ['c', 'a', 'b'] }, { arrayLimit: 2 });
  assert.deepEqual(result, { labels: { added: ['a', 'b'], truncated: true } });
  assert.throws(() => diffFingerprint({}, {}, { arrayLimit: -1 }), /arrayLimit/);
});

test('diffFingerprint has no omissions: every fingerprint key that differs produces a changed entry', () => {
  const from = {
    state: 'open',
    updatedAt: 'old',
    isDraft: false,
    headSha: 'sha1',
    baseRef: 'main',
    mergeable: 'unknown',
    mergeStateStatus: 'unknown',
    reviewDecision: 'none',
    checks: [],
    reviews: [
      { id: 'PRR_1', author: 'alice', state: 'commented', submittedAt: 't1', commit: 'c1' },
    ],
    threads: [{ id: 'T_A', resolved: false, comments: 0 }],
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'IC_1', author: 'alice' }],
    labels: [],
    assignees: [],
    reviewRequests: [],
  };
  const to = {
    state: 'closed',
    updatedAt: 'new',
    isDraft: true,
    headSha: 'sha2',
    baseRef: 'dev',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'approved',
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviews: [{ id: 'PRR_2', author: 'bob', state: 'approved', submittedAt: 't2', commit: 'c2' }],
    threads: [{ id: 'T_A', resolved: true, comments: 1 }],
    comments: 2,
    conversationComments: 2,
    recentComments: [{ id: 'IC_2', author: 'bob' }],
    labels: ['x'],
    assignees: ['bob'],
    reviewRequests: ['alice'],
  };
  const result = diffFingerprint(from, to);
  for (const key of Object.keys(from)) {
    assert.ok(Object.hasOwn(result, key), `expected a changed entry for "${key}"`);
  }
});

test('diffFingerprint names added/removed/changed reviews by id, and checks by name', () => {
  const from = {
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviews: [
      { id: 'PRR_1', author: 'alice', state: 'commented', submittedAt: 't1', commit: 'c1' },
    ],
  };
  const to = {
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
    reviews: [
      { id: 'PRR_1', author: 'alice', state: 'commented', submittedAt: 't1', commit: 'c1' },
      { id: 'PRR_2', author: 'bob', state: 'approved', submittedAt: 't2', commit: 'c2' },
    ],
  };
  const result = diffFingerprint(from, to);
  assert.deepEqual(result.checks, { failed: ['build'] });
  assert.deepEqual(result.reviews, { added: ['PRR_2'] });
});

test('diffFingerprint marks checks opaque instead of silently dropping a duplicate check name', () => {
  // Two rows named `test` (a CheckRun and a StatusContext sharing one name,
  // or a re-run): the name-keyed map can only keep one, so a real failure ->
  // success flip on the shadowed row must not be reported as "nothing
  // changed" -- see lib/fingerprint.mjs buildChecks for the same ambiguity
  // at the sort-key level.
  const from = {
    checks: [
      { name: 'test', kind: 'check', status: 'completed', conclusion: 'failure' },
      { name: 'test', kind: 'status', status: 'success', conclusion: 'success' },
    ],
  };
  const to = {
    checks: [
      { name: 'test', kind: 'check', status: 'completed', conclusion: 'success' },
      { name: 'test', kind: 'status', status: 'success', conclusion: 'success' },
    ],
  };
  const result = diffFingerprint(from, to);
  assert.deepEqual(result.checks, { opaque: true });
});

test('diffFingerprint names added/removed thread ids and recentComment ids', () => {
  const from = {
    threads: [{ id: 'T_A', resolved: false, comments: 0 }],
    recentComments: [{ id: 'IC_1', author: 'alice' }],
  };
  const to = {
    threads: [
      { id: 'T_A', resolved: true, comments: 0 },
      { id: 'T_B', resolved: false, comments: 1 },
    ],
    recentComments: [
      { id: 'IC_1', author: 'alice' },
      { id: 'IC_2', author: 'bob' },
    ],
  };
  const result = diffFingerprint(from, to);
  assert.deepEqual(result.threads, { added: ['T_B'], changed: ['T_A'] });
  assert.deepEqual(result.recentComments, { added: ['IC_2'] });
});
