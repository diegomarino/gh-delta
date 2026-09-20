// GitHub GraphQL boundary tests: incremental fetch, cutoff, caps, and normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPRs,
  fetchPRsByNumber,
  fetchIssues,
  fetchEnrichment,
  DEFAULT_GH_TIMEOUT_MS,
} from '../lib/gh.mjs';

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

test('enrichment fetch uses one sorted nodes query and normalizes review bodies by requested id', () => {
  const calls = [];
  const rows = fetchEnrichment('review', ['R2', 'R1', 'R2'], {
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({
        data: {
          nodes: [
            {
              __typename: 'PullRequestReview',
              id: 'R1',
              body: 'please fix',
              state: 'CHANGES_REQUESTED',
              submittedAt: '2026-07-01T10:00:00Z',
              author: { login: 'alice' },
              commit: { oid: 'abc' },
            },
            {
              __typename: 'PullRequestReview',
              id: 'R2',
              body: '',
              state: 'CHANGES_REQUESTED',
              submittedAt: null,
              author: null,
              commit: null,
            },
          ],
        },
      });
    },
    timeoutMs: 123,
    onProgress: () => calls.push({ progress: true }),
  });
  assert.equal(calls.filter((call) => call.args).length, 1);
  assert.deepEqual(
    calls.find((call) => call.args).args.filter((arg) => arg.startsWith('ids[]=')),
    ['ids[]=R1', 'ids[]=R2'],
  );
  assert.equal(calls.find((call) => call.args).opts.timeoutMs, 123);
  assert.equal(calls.filter((call) => call.progress).length, 1);
  assert.deepEqual(rows, [
    {
      id: 'R1',
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-07-01T10:00:00Z',
      commit: 'abc',
      body: 'please fix',
    },
    {
      id: 'R2',
      author: null,
      state: 'CHANGES_REQUESTED',
      submittedAt: null,
      commit: null,
      body: '',
    },
  ]);
});

test('enrichment fetch fails closed on node coverage, wrong type, and malformed thread connection', () => {
  for (const body of [
    { data: { nodes: [] } },
    { data: { nodes: [{ __typename: 'IssueComment', id: 'R1' }] } },
    {
      data: {
        nodes: [
          {
            __typename: 'PullRequestReviewThread',
            id: 'T1',
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        ],
      },
    },
  ]) {
    assert.throws(
      () =>
        fetchEnrichment(
          body.data.nodes[0]?.__typename === 'PullRequestReviewThread' ? 'threads' : 'review',
          ['R1'],
          { exec: () => JSON.stringify(body) },
        ),
      /unexpected shape|coverage/,
    );
  }
});

test('enrichment progress advances after a successful process return even when JSON validation fails', () => {
  let progress = 0;
  assert.throws(
    () =>
      fetchEnrichment('comments', ['C1'], {
        exec: () => 'not-json',
        onProgress: () => progress++,
      }),
    /invalid JSON/,
  );
  assert.equal(progress, 1);

  assert.throws(
    () =>
      fetchEnrichment('comments', ['C1'], {
        exec: () => {
          throw new Error('process failed');
        },
        onProgress: () => progress++,
      }),
    /process failed/,
  );
  assert.equal(progress, 1);
});

test('targeted PR fetch uses one aliased query and the canonical normalizer', () => {
  const calls = [];
  const rows = fetchPRsByNumber('o/r', [9, 3, 9], {
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({
        data: { repository: { pr3: prNode({ number: 3 }), pr9: prNode({ number: 9 }) } },
      });
    },
    onProgress: () => calls.push({ progress: true }),
  });
  assert.equal(calls.filter((call) => call.args).length, 1);
  const query = calls.find((call) => call.args).args.find((arg) => arg.startsWith('query='));
  assert.match(query, /pr3: pullRequest\(number: \$n3\)/);
  assert.match(query, /pr9: pullRequest\(number: \$n9\)/);
  assert.equal(calls.filter((call) => call.progress).length, 1);
  assert.deepEqual(
    rows.map((row) => row.number),
    [3, 9],
  );
  assert.deepEqual(rows[0].statusCheckRollup, [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
});

test('targeted PR fetch fails closed on alias shape, GraphQL errors, and nested overflow', () => {
  assert.throws(
    () =>
      fetchPRsByNumber('o/r', [3], { exec: () => JSON.stringify({ data: { repository: {} } }) }),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      fetchPRsByNumber('o/r', [3], {
        exec: () => JSON.stringify({ errors: [{ message: 'boom' }] }),
      }),
    /returned errors: boom/,
  );
  const overflow = prNode({ number: 3 });
  overflow.reviewThreads.pageInfo.hasNextPage = true;
  assert.throws(
    () =>
      fetchPRsByNumber('o/r', [3], {
        exec: () => JSON.stringify({ data: { repository: { pr3: overflow } } }),
      }),
    /paginated reviewThreads/,
  );
});

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

test('queries and normalizes bounded comment identities plus failed check URLs', () => {
  let prQuery = '';
  const prs = fetchPRs('o/r', {
    exec: (_cmd, args) => {
      prQuery = args.find((arg) => arg.startsWith('query=')) ?? '';
      return page([
        prNode({
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
                          conclusion: 'FAILURE',
                          detailsUrl: 'https://ci/build',
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            ],
          },
          comments: { nodes: [{ id: 'C1', author: { login: 'Bot[bot]' } }] },
        }),
      ]);
    },
    horizonCutoff: null,
  });
  assert.match(prQuery, /CheckRun \{ name status conclusion detailsUrl \}/);
  assert.match(prQuery, /comments\(last: 5\) \{ totalCount nodes \{ id author \{ login \} \} \}/);
  assert.deepEqual(prs[0].commentNodes, [{ id: 'C1', author: 'Bot[bot]' }]);
  assert.equal(prs[0].statusCheckRollup[0].detailsUrl, 'https://ci/build');

  let issueQuery = '';
  const issues = fetchIssues('o/r', {
    exec: (_cmd, args) => {
      issueQuery = args.find((arg) => arg.startsWith('query=')) ?? '';
      return page([
        {
          number: 2,
          title: 'issue',
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          assignees: { nodes: [], pageInfo: { hasNextPage: false } },
          comments: { totalCount: 1, nodes: [{ id: 'I1', author: { login: 'bot' } }] },
        },
      ]);
    },
    horizonCutoff: null,
  });
  assert.match(
    issueQuery,
    /comments\(last: 5\) \{ totalCount nodes \{ id author \{ login \} \} \}/,
  );
  assert.deepEqual(issues[0].commentNodes, [{ id: 'I1', author: 'bot' }]);
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

test('the PR query requests review-thread id and normalizePr carries reviewThreadNodes', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      prNode({
        reviewThreads: {
          totalCount: 2,
          nodes: [
            { id: 'T_A', isResolved: false },
            { id: 'T_B', isResolved: true },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.match(sentQuery, /reviewThreads\(first: \d+\) \{ totalCount nodes \{ id isResolved \}/);
  assert.deepEqual(rows[0].reviewThreadNodes, [
    { id: 'T_A', isResolved: false },
    { id: 'T_B', isResolved: true },
  ]);
});

test('normalizePr drops review threads with no id and defaults reviewThreadNodes to [] when absent', () => {
  const exec = () =>
    page([
      prNode({
        reviewThreads: {
          totalCount: 1,
          nodes: [{ isResolved: false }], // no id
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].reviewThreadNodes, []);
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

test('GraphQL variables are passed as raw -f fields so literal-looking slugs stay strings', () => {
  // Regression: -F applies gh's magic type coercion, so an all-digit or boolean
  // slug like `2048` becomes an integer that GitHub rejects for the String!
  // variable, failing every tick. Every variable here must go out as `-f`.
  let captured = [];
  const exec = (_cmd, args) => {
    captured = args;
    return page([prNode()]);
  };
  fetchPRs('gabrielecirulli/2048', { exec, horizonCutoff: null });

  assert.ok(!captured.includes('-F'), 'no GraphQL variable may use gh -F (type coercion)');
  assert.ok(
    !captured.includes('--field'),
    'no GraphQL variable may use gh --field (type coercion)',
  );

  const nameIdx = captured.indexOf('name=2048');
  assert.ok(nameIdx > 0, 'expected the repo name to be passed as a variable');
  assert.equal(captured[nameIdx - 1], '-f', 'name=2048 must be preceded by -f, never -F');

  const ownerIdx = captured.indexOf('owner=gabrielecirulli');
  assert.equal(captured[ownerIdx - 1], '-f', 'owner must be passed as a raw -f field');

  const statesIdx = captured.indexOf('states[]=OPEN');
  assert.equal(captured[statesIdx - 1], '-f', 'array variables must also use -f');
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

test('the PR query requests mergeStateStatus and normalizePr defaults it to UNKNOWN if absent', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([prNode()]); // prNode() omits mergeStateStatus
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.ok(
    sentQuery.includes('mergeStateStatus'),
    'PR GraphQL selection must request mergeStateStatus',
  );
  assert.equal(rows[0].mergeStateStatus, 'UNKNOWN');
});

test('the PR query requests base ref, labels, assignees, and review requests and normalizePr carries them', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      prNode({
        baseRefName: 'main',
        labels: { nodes: [null, { name: 'bug' }], pageInfo: { hasNextPage: false } },
        assignees: { nodes: [{ login: 'alice' }, null], pageInfo: { hasNextPage: false } },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { login: 'bob' } },
            { requestedReviewer: { combinedSlug: 'org/platform-team' } },
            null,
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
  };
  const rows = fetchPRs('o/r', { exec, horizonCutoff: null });
  for (const field of ['baseRefName', 'labels', 'assignees', 'reviewRequests']) {
    assert.ok(sentQuery.includes(field), `PR GraphQL selection must request ${field}`);
  }
  assert.equal(rows[0].baseRefName, 'main');
  assert.deepEqual(rows[0].labels, [{ name: 'bug' }]);
  assert.deepEqual(rows[0].assignees, ['alice']);
  assert.deepEqual(rows[0].reviewRequests, ['bob', 'org/platform-team']);
});

test('normalizePr defaults the new fields when a node predates them', () => {
  const rows = fetchPRs('o/r', { exec: () => page([prNode()]), horizonCutoff: null });
  assert.equal(rows[0].baseRefName, '');
  assert.deepEqual(rows[0].labels, []);
  assert.deepEqual(rows[0].assignees, []);
  assert.deepEqual(rows[0].reviewRequests, []);
});

test('fails closed on paginated PR assignees', () => {
  const overflow = prNode({
    assignees: { nodes: [{ login: 'alice' }], pageInfo: { hasNextPage: true } },
  });
  assert.throws(() => fetchPRs('o/r', { exec: () => page([overflow]) }), /paginated assignees/);
});

test('the issue query requests assignees and fetchIssues normalizes them', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      {
        number: 7,
        title: 'bug',
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        assignees: {
          nodes: [{ login: 'zoe' }, { login: 'alice' }],
          pageInfo: { hasNextPage: false },
        },
        comments: { totalCount: 0 },
      },
    ]);
  };
  const rows = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.ok(sentQuery.includes('assignees'), 'issue GraphQL selection must request assignees');
  assert.deepEqual(rows[0].assignees, ['zoe', 'alice']);
});

test('normalizePr passes through a present mergeStateStatus verbatim', () => {
  const rows = fetchPRs('o/r', {
    exec: () => page([prNode({ mergeStateStatus: 'BEHIND' })]),
    horizonCutoff: null,
  });
  assert.equal(rows[0].mergeStateStatus, 'BEHIND');
});
