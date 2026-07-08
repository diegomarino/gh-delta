// GitHub GraphQL boundary tests: incremental fetch, cutoff, caps, and normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPRs, fetchIssues, DEFAULT_GH_TIMEOUT_MS } from '../lib/gh.mjs';

function prNode(over = {}) {
  return {
    number: 1,
    title: 'one',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    totalCommentsCount: 2,
    headRefOid: 'sha1',
    headRefName: 'feature/one',
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: 'CheckRun',
                    name: 'build',
                    status: 'COMPLETED',
                    conclusion: 'SUCCESS',
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewThreads: {
      totalCount: 2,
      nodes: [{ isResolved: false }, { isResolved: true }],
      pageInfo: { hasNextPage: false },
    },
    ...over,
  };
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return JSON.stringify({
    data: { repository: { items: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  });
}

test('baseline (null horizon) fetches only open PRs and normalizes rows', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return page([prNode()]);
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.some((a) => a === 'states[]=OPEN'));
  assert.equal(calls[0].opts.timeoutMs, DEFAULT_GH_TIMEOUT_MS);
  assert.deepEqual(rows[0].statusCheckRollup, [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  assert.equal(rows[0].totalCommentsCount, 2);
  assert.equal(rows[0].reviewThreads, 2);
  assert.equal(rows[0].unresolvedReviewThreads, 1);
});

test('incremental fetch adds updated items and cuts at the horizon', () => {
  const calls = [];
  const exec = (_cmd, args) => {
    calls.push(args);
    const isOpenPhase = args.some((a) => a === 'states[]=OPEN');
    if (isOpenPhase) return page([prNode()]);
    return page([
      prNode({ number: 9, state: 'MERGED', updatedAt: '2026-07-01T12:00:00Z' }),
      prNode({ number: 1, updatedAt: '2026-07-01T10:00:00Z' }), // duplicate of open row
      prNode({ number: 3, state: 'CLOSED', updatedAt: '2026-06-30T00:00:00Z' }), // below cutoff
    ]);
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: '2026-07-01T00:00:00Z' });
  assert.deepEqual(rows.map((r) => r.number).sort(), [1, 9]);
  assert.equal(calls.length, 2);
  const updatedCall = calls.find((args) => !args.some((a) => a === 'states[]=OPEN'));
  assert.ok(updatedCall, 'expected an updated-phase call without states[]=OPEN');
  assert.ok(
    !updatedCall.some((a) => a.startsWith('states')),
    'updated phase must omit states so GitHub applies no state filter',
  );
});

test('cutoff stops pagination early', () => {
  let updatedCalls = 0;
  const exec = (_cmd, args) => {
    if (args.some((a) => a === 'states[]=OPEN')) return page([]);
    updatedCalls++;
    return page([prNode({ number: 5, updatedAt: '2026-01-01T00:00:00Z' })], true, 'c1');
  };
  fetchPRs('o/r', { exec, horizonCutoff: '2026-07-01T00:00:00Z' });
  assert.equal(updatedCalls, 1); // hasNextPage true but every node is below cutoff
});

test('fails closed when open items exceed the page cap', () => {
  const exec = () => page([prNode()], true, 'c');
  assert.throws(() => fetchPRs('o/r', { exec, horizonCutoff: null }), /exceeded 10 pages/);
});

test('fails closed on nested pagination and GraphQL errors', () => {
  const overflow = prNode();
  overflow.reviewThreads.pageInfo.hasNextPage = true;
  assert.throws(() => fetchPRs('o/r', { exec: () => page([overflow]) }), /paginated reviewThreads/);
  assert.throws(
    () => fetchPRs('o/r', { exec: () => JSON.stringify({ errors: [{ message: 'boom' }] }) }),
    /returned errors: boom/,
  );
});

test('fetchIssues normalizes labels and exact comment totals', () => {
  const exec = (_cmd, args) => {
    assert.ok(args.some((a) => a.startsWith('query=')));
    return page([
      {
        number: 7,
        title: 'bug',
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        labels: { nodes: [{ name: 'worker' }], pageInfo: { hasNextPage: false } },
        comments: { totalCount: 130 },
      },
    ]);
  };
  const rows = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].labels, [{ name: 'worker' }]);
  assert.equal(rows[0].comments, 130);
});

test('normalizeIssue filters null elements from labels nodes', () => {
  const exec = () =>
    page([
      {
        number: 11,
        title: 'nulls',
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        labels: { nodes: [null, { name: 'worker' }], pageInfo: { hasNextPage: false } },
        comments: { totalCount: 0 },
      },
    ]);
  const rows = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].labels, [{ name: 'worker' }]);
});

test('the PR query requests headRefName and normalizePr carries it (defensively null if absent)', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([prNode({ headRefName: 'feature/login' })]);
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.ok(sentQuery.includes('headRefName'), 'PR GraphQL selection must request headRefName');
  assert.equal(rows[0].headRefName, 'feature/login');

  // Defensive: GitHub's headRefName is String! and retained after deletion, but
  // if a node ever lacks it, normalize to null rather than undefined (never throw).
  const missingName = fetchPRs('o/r', {
    exec: () => page([prNode({ headRefName: null })]),
    horizonCutoff: null,
  });
  assert.equal(missingName[0].headRefName, null);
});

test('normalizePr filters null elements from statusCheckRollup contexts nodes', () => {
  const nodeWithNullContext = prNode({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  null,
                  {
                    __typename: 'CheckRun',
                    name: 'build',
                    status: 'COMPLETED',
                    conclusion: 'SUCCESS',
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
  });
  const rows = fetchPRs('o/r', { exec: () => page([nodeWithNullContext]), horizonCutoff: null });
  assert.deepEqual(rows[0].statusCheckRollup, [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
});
