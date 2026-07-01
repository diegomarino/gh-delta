// GitHub CLI boundary tests: broad fetch flags are required for observable deltas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPRs, fetchIssues, PR_FIELDS, ISSUE_FIELDS } from '../lib/gh.mjs';

test('fetchPRs sends --state all and --limit 500 with the PR fields', () => {
  let captured;
  const exec = (cmd, args) => { captured = { cmd, args }; return '[]'; };
  const out = fetchPRs('owner/repo', exec);
  assert.deepEqual(out, []);
  assert.equal(captured.cmd, 'gh');
  assert.ok(captured.args.includes('--state'));
  assert.ok(captured.args.includes('all'));
  assert.ok(captured.args.includes('--limit'));
  assert.ok(captured.args.includes('500'));
  assert.ok(captured.args.includes(PR_FIELDS));
  assert.deepEqual(captured.args.slice(0, 4), ['pr', 'list', '-R', 'owner/repo']);
});

test('fetchPRs parses JSON stdout', () => {
  const exec = () => JSON.stringify([{ number: 1, state: 'OPEN' }]);
  assert.deepEqual(fetchPRs('o/r', exec), [{ number: 1, state: 'OPEN' }]);
});

test('fetchPRs fails closed when the result reaches the hard limit', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ number: i + 1 }));
  const exec = () => JSON.stringify(rows);
  assert.throws(() => fetchPRs('o/r', exec), /returned 500 PRs/);
});

test('fetchIssues sends the issue field set', () => {
  let captured;
  const exec = (cmd, args) => { captured = { cmd, args }; return '[]'; };
  fetchIssues('o/r', exec);
  assert.ok(captured.args.includes(ISSUE_FIELDS));
  assert.deepEqual(captured.args.slice(0, 2), ['issue', 'list']);
});

test('fetchIssues fails closed when the result reaches the hard limit', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ number: i + 1 }));
  const exec = () => JSON.stringify(rows);
  assert.throws(() => fetchIssues('o/r', exec), /returned 500 issues/);
});

test('PR_FIELDS carries the review-vs-comment-distinct signals', () => {
  for (const f of ['statusCheckRollup', 'reviewDecision', 'latestReviews', 'mergeable', 'comments', 'headRefOid']) {
    assert.ok(PR_FIELDS.includes(f), `missing ${f}`);
  }
});
