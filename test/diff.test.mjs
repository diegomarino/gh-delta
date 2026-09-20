import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFingerprint } from '../lib/diff.mjs';

test('diffFingerprint reports semantic fingerprint changes without volatile mirrors', () => {
  const from = {
    updatedAt: 'old',
    ci: 'opaque',
    ciChecks: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }],
    labels: ['a'],
    assignees: ['zoe'],
    reviewRequests: ['team'],
    comments: 1,
  };
  const to = {
    updatedAt: 'new',
    ci: 'other',
    ciChecks: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    labels: ['b'],
    assignees: ['alice'],
    reviewRequests: ['team'],
    comments: 2,
  };
  assert.deepEqual(diffFingerprint(from, to), {
    assignees: { added: ['alice'], removed: ['zoe'] },
    ci: { from: 'failed', to: 'green' },
    ciChecks: { fixed: ['lint'] },
    comments: { from: 1, to: 2 },
    labels: { added: ['b'], removed: ['a'] },
  });
  assert.equal(from.updatedAt, 'old');
});

test('diffFingerprint caps every array independently', () => {
  const result = diffFingerprint({ labels: [] }, { labels: ['c', 'a', 'b'] }, { arrayLimit: 2 });
  assert.deepEqual(result, { labels: { added: ['a', 'b'], truncated: true } });
  assert.throws(() => diffFingerprint({}, {}, { arrayLimit: -1 }), /arrayLimit/);
});
