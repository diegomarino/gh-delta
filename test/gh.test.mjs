// GitHub GraphQL boundary tests: incremental fetch, cutoff, caps, and normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPRs,
  fetchPRsByNumber,
  fetchIssues,
  fetchEnrichment,
  fetchThreadReplies,
  fetchRateLimit,
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
      nodes: [
        { id: 'T_A', isResolved: false },
        { id: 'T_B', isResolved: true },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...over,
  };
}

function page(nodes, hasNextPage = false, endCursor = null, rateLimit = DEFAULT_PAGE_RATE_LIMIT) {
  return JSON.stringify({
    data: {
      rateLimit,
      repository: { items: { nodes, pageInfo: { hasNextPage, endCursor } } },
    },
  });
}

// Every gh.mjs GraphQL query requests `rateLimit { cost remaining resetAt }`
// alongside its real selection; most fixtures below don't care about the
// exact numbers, so this is the shared default a `page()` call gets unless
// it overrides `rateLimit` explicitly.
const DEFAULT_PAGE_RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };

test('rate-limit fetch invokes the REST boundary once, reports progress, and normalizes resetAt', () => {
  const calls = [];
  const result = fetchRateLimit({
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({ resources: { graphql: { remaining: 12, reset: 1780000000 } } });
    },
    timeoutMs: 321,
    onProgress: () => calls.push({ progress: true }),
  });
  assert.deepEqual(result, { remaining: 12, resetAt: '2026-05-28T20:26:40.000Z' });
  assert.deepEqual(calls[0], { args: ['api', 'rate_limit'], opts: { timeoutMs: 321 } });
  assert.equal(calls.filter((call) => call.progress).length, 1);
});

test('rate-limit fetch fails closed for invalid payload and never progresses after a process failure', () => {
  assert.throws(
    () => fetchRateLimit({ exec: () => '{' }),
    /GitHub rate-limit returned invalid JSON/,
  );
  for (const payload of [
    {},
    { resources: { graphql: { remaining: -1, reset: 1 } } },
    { resources: { graphql: { remaining: 1.5, reset: 1 } } },
    { resources: { graphql: { remaining: Number.MAX_SAFE_INTEGER + 1, reset: 1 } } },
    { resources: { graphql: { remaining: 1, reset: '1' } } },
    { resources: { graphql: { remaining: 1, reset: Number.MAX_SAFE_INTEGER } } },
  ]) {
    assert.throws(
      () => fetchRateLimit({ exec: () => JSON.stringify(payload) }),
      /GitHub rate-limit returned unexpected shape/,
    );
  }
  let progress = 0;
  assert.throws(
    () =>
      fetchRateLimit({
        exec: () => {
          throw new Error('process failed');
        },
        onProgress: () => progress++,
      }),
    /process failed/,
  );
  assert.equal(progress, 0);
});

test('enrichment fetch uses one sorted nodes query and normalizes review bodies by requested id', () => {
  const calls = [];
  const { rows, rateLimit } = fetchEnrichment('review', ['R2', 'R1', 'R2'], {
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({
        data: {
          rateLimit: DEFAULT_PAGE_RATE_LIMIT,
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
  assert.deepEqual(rateLimit, DEFAULT_PAGE_RATE_LIMIT);
});

test('enrichment fetch fails closed on node coverage, wrong type, and malformed thread connection', () => {
  for (const body of [
    { data: { rateLimit: DEFAULT_PAGE_RATE_LIMIT, nodes: [] } },
    {
      data: {
        rateLimit: DEFAULT_PAGE_RATE_LIMIT,
        nodes: [{ __typename: 'IssueComment', id: 'R1' }],
      },
    },
    {
      data: {
        rateLimit: DEFAULT_PAGE_RATE_LIMIT,
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
  const { rows, rateLimit } = fetchPRsByNumber('o/r', [9, 3, 9], {
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({
        data: {
          rateLimit: DEFAULT_PAGE_RATE_LIMIT,
          repository: { pr3: prNode({ number: 3 }), pr9: prNode({ number: 9 }) },
        },
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
  assert.deepEqual(rows[0].checks, [
    { name: 'build', kind: 'check', status: 'completed', conclusion: 'success', detailsUrl: null },
  ]);
  assert.deepEqual(rateLimit, DEFAULT_PAGE_RATE_LIMIT);
});

test('targeted PR fetch returns an empty rows/null rateLimit without calling gh for an empty number set', () => {
  assert.deepEqual(fetchPRsByNumber('o/r', [], { exec: () => assert.fail('must not fetch') }), {
    rows: [],
    rateLimit: null,
  });
});

test('targeted PR fetch fails closed on alias shape, GraphQL errors, and nested overflow', () => {
  assert.throws(
    () =>
      fetchPRsByNumber('o/r', [3], {
        exec: () =>
          JSON.stringify({ data: { rateLimit: DEFAULT_PAGE_RATE_LIMIT, repository: {} } }),
      }),
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
        exec: () =>
          JSON.stringify({
            data: { rateLimit: DEFAULT_PAGE_RATE_LIMIT, repository: { pr3: overflow } },
          }),
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
  const { rows, rateLimit } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.some((a) => a === 'states[]=OPEN'));
  assert.equal(calls[0].opts.timeoutMs, DEFAULT_GH_TIMEOUT_MS);
  assert.deepEqual(rows[0].checks, [
    { name: 'build', kind: 'check', status: 'completed', conclusion: 'success', detailsUrl: null },
  ]);
  assert.equal(rows[0].conversationComments, 0);
  assert.equal(rows[0].reviewComments, 2);
  assert.equal(rows[0].comments, undefined);
  assert.deepEqual(rows[0].threads, [
    { id: 'T_A', resolved: false, comments: 0 },
    { id: 'T_B', resolved: true, comments: 0 },
  ]);
  assert.deepEqual(rateLimit, DEFAULT_PAGE_RATE_LIMIT);
});

test('normalizePr splits conversation and review comment counts', () => {
  const node = prNode({
    totalCommentsCount: 7,
    comments: { totalCount: 3, nodes: [] },
  });
  const { rows } = fetchPRs('o/r', { exec: () => page([node]) });
  assert.equal(rows[0].conversationComments, 3);
  assert.equal(rows[0].reviewComments, 4);
  assert.equal(rows[0].comments, undefined);
});

test('normalizePr clamps a negative reviewComments to zero instead of emitting one', () => {
  const node = prNode({
    totalCommentsCount: 2, // fewer than the conversation count: read-replica skew
    comments: { totalCount: 5, nodes: [] },
  });
  const { rows } = fetchPRs('o/r', { exec: () => page([node]) });
  assert.equal(rows[0].conversationComments, 5);
  assert.equal(rows[0].reviewComments, 0);
});

test('queries and normalizes bounded comment identities plus failed check URLs', () => {
  let prQuery = '';
  const { rows: prs } = fetchPRs('o/r', {
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
  assert.deepEqual(prs[0].recentComments, [{ id: 'C1', author: 'Bot[bot]' }]);
  assert.equal(prs[0].checks[0].detailsUrl, 'https://ci/build');

  let issueQuery = '';
  const { rows: issues } = fetchIssues('o/r', {
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
  assert.deepEqual(issues[0].recentComments, [{ id: 'I1', author: 'bot' }]);
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
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: '2026-07-01T00:00:00Z' });
  assert.deepEqual(rows.map((r) => r.number).sort(), [1, 9]);
  assert.equal(calls.length, 2);
  const updatedCall = calls.find((args) => !args.some((a) => a === 'states[]=OPEN'));
  assert.ok(updatedCall, 'expected an updated-phase call without states[]=OPEN');
  assert.ok(
    !updatedCall.some((a) => a.startsWith('states')),
    'updated phase must omit states so GitHub applies no state filter',
  );
});

test('a two-page fetch sums cost across pages and keeps the last remaining/resetAt', () => {
  let call = 0;
  const exec = () => {
    call++;
    if (call === 1) {
      return page([prNode({ number: 1 })], true, 'c1', {
        cost: 1,
        remaining: 100,
        resetAt: '2026-07-01T13:00:00.000Z',
      });
    }
    return page([prNode({ number: 2 })], false, null, {
      cost: 1,
      remaining: 99,
      resetAt: '2026-07-01T13:00:01.000Z',
    });
  };
  const { rows, rateLimit } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.equal(call, 2);
  assert.deepEqual(
    rows.map((r) => r.number),
    [1, 2],
  );
  assert.deepEqual(rateLimit, { cost: 2, remaining: 99, resetAt: '2026-07-01T13:00:01.000Z' });
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

test('the PR query requests review-thread id/comments and normalizePr carries threads[]', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      prNode({
        reviewThreads: {
          totalCount: 2,
          nodes: [
            { id: 'T_A', isResolved: false, comments: { totalCount: 3 } },
            { id: 'T_B', isResolved: true, comments: { totalCount: 0 } },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
  };
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.match(
    sentQuery,
    /reviewThreads\(first: \d+\) \{ totalCount nodes \{ id isResolved comments \{ totalCount \} \}/,
  );
  assert.deepEqual(rows[0].threads, [
    { id: 'T_A', resolved: false, comments: 3 },
    { id: 'T_B', resolved: true, comments: 0 },
  ]);
});

test('normalizePr drops review threads with no id and defaults threads to [] when absent', () => {
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
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].threads, []);
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
  const { rows } = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].labels, [{ name: 'worker' }]);
  assert.equal(rows[0].conversationComments, 130);
  assert.equal(rows[0].comments, undefined);
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
  const { rows } = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.deepEqual(rows[0].labels, [{ name: 'worker' }]);
});

test('the PR query requests headRefName and normalizePr carries it (defensively null if absent)', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([prNode({ headRefName: 'feature/login' })]);
  };
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.ok(sentQuery.includes('headRefName'), 'PR GraphQL selection must request headRefName');
  assert.equal(rows[0].headRefName, 'feature/login');

  // Defensive: GitHub's headRefName is String! and retained after deletion, but
  // if a node ever lacks it, normalize to null rather than undefined (never throw).
  const { rows: missingName } = fetchPRs('o/r', {
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
  const { rows } = fetchPRs('o/r', {
    exec: () => page([nodeWithNullContext]),
    horizonCutoff: null,
  });
  assert.deepEqual(rows[0].checks, [
    { name: 'build', kind: 'check', status: 'completed', conclusion: 'success', detailsUrl: null },
  ]);
});

test('the PR query requests mergeStateStatus and normalizePr defaults it to unknown if absent', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([prNode()]); // prNode() omits mergeStateStatus
  };
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  assert.ok(
    sentQuery.includes('mergeStateStatus'),
    'PR GraphQL selection must request mergeStateStatus',
  );
  assert.equal(rows[0].mergeStateStatus, 'unknown');
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
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  for (const field of ['baseRefName', 'labels', 'assignees', 'reviewRequests']) {
    assert.ok(sentQuery.includes(field), `PR GraphQL selection must request ${field}`);
  }
  assert.equal(rows[0].baseRef, 'main');
  assert.deepEqual(rows[0].labels, [{ name: 'bug' }]);
  assert.deepEqual(rows[0].assignees, ['alice']);
  assert.deepEqual(rows[0].reviewRequests, ['bob', 'org/platform-team']);
});

test('normalizePr defaults the new fields when a node predates them', () => {
  const { rows } = fetchPRs('o/r', { exec: () => page([prNode()]), horizonCutoff: null });
  assert.equal(rows[0].baseRef, '');
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
  const { rows } = fetchIssues('o/r', { exec, horizonCutoff: null });
  assert.ok(sentQuery.includes('assignees'), 'issue GraphQL selection must request assignees');
  assert.deepEqual(rows[0].assignees, ['zoe', 'alice']);
});

test('normalizePr passes through a present mergeStateStatus verbatim', () => {
  const { rows } = fetchPRs('o/r', {
    exec: () => page([prNode({ mergeStateStatus: 'BEHIND' })]),
    horizonCutoff: null,
  });
  assert.equal(rows[0].mergeStateStatus, 'behind');
});

test('the PR query requests id/author/createdAt/url and normalizePr carries them (F2)', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      prNode({
        id: 'PR_node1',
        author: { login: 'octocat' },
        createdAt: '2026-06-01T00:00:00Z',
        url: 'https://github.com/o/r/pull/1',
      }),
    ]);
  };
  const { rows } = fetchPRs('o/r', { exec, horizonCutoff: null });
  for (const scalar of ['id', 'author { login }', 'createdAt', 'url']) {
    assert.ok(sentQuery.includes(scalar), `PR GraphQL selection must request ${scalar}`);
  }
  assert.equal(rows[0].id, 'PR_node1');
  assert.equal(rows[0].author, 'octocat');
  assert.equal(rows[0].createdAt, '2026-06-01T00:00:00Z');
  assert.equal(rows[0].url, 'https://github.com/o/r/pull/1');

  // Defensive: a deleted/ghost author normalizes to null rather than throwing.
  const { rows: ghost } = fetchPRs('o/r', {
    exec: () => page([prNode({ author: null })]),
    horizonCutoff: null,
  });
  assert.equal(ghost[0].author, null);
});

test('the issue query requests id/author/createdAt/url and normalizeIssue carries them (F2)', () => {
  let sentQuery = '';
  const exec = (_cmd, args) => {
    sentQuery = args.find((a) => a.startsWith('query=')) ?? '';
    return page([
      {
        number: 9,
        title: 'bug',
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        id: 'I_node1',
        author: { login: 'octocat' },
        createdAt: '2026-06-01T00:00:00Z',
        url: 'https://github.com/o/r/issues/9',
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        comments: { totalCount: 0 },
      },
    ]);
  };
  const { rows } = fetchIssues('o/r', { exec, horizonCutoff: null });
  for (const scalar of ['id', 'author { login }', 'createdAt', 'url']) {
    assert.ok(sentQuery.includes(scalar), `issue GraphQL selection must request ${scalar}`);
  }
  assert.equal(rows[0].id, 'I_node1');
  assert.equal(rows[0].author, 'octocat');
  assert.equal(rows[0].createdAt, '2026-06-01T00:00:00Z');
  assert.equal(rows[0].url, 'https://github.com/o/r/issues/9');
});

test('body enrichment fetches an item body via nodes(ids:) accepting either Issue or PullRequest', () => {
  const calls = [];
  const { rows, rateLimit } = fetchEnrichment('body', ['I_1'], {
    exec: (_cmd, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({
        data: {
          rateLimit: DEFAULT_PAGE_RATE_LIMIT,
          nodes: [{ __typename: 'Issue', id: 'I_1', body: 'please review @alice' }],
        },
      });
    },
  });
  assert.deepEqual(
    calls[0].args.filter((arg) => arg.startsWith('ids[]=')),
    ['ids[]=I_1'],
  );
  assert.deepEqual(rows, [{ id: 'I_1', body: 'please review @alice' }]);
  assert.deepEqual(rateLimit, DEFAULT_PAGE_RATE_LIMIT);

  const pr = fetchEnrichment('body', ['PR_1'], {
    exec: () =>
      JSON.stringify({
        data: {
          rateLimit: DEFAULT_PAGE_RATE_LIMIT,
          nodes: [{ __typename: 'PullRequest', id: 'PR_1', body: 'fixes #1' }],
        },
      }),
  });
  assert.deepEqual(pr.rows, [{ id: 'PR_1', body: 'fixes #1' }]);
});

test('body enrichment fails closed on a node type that is neither Issue nor PullRequest', () => {
  assert.throws(
    () =>
      fetchEnrichment('body', ['C_1'], {
        exec: () =>
          JSON.stringify({
            data: {
              rateLimit: DEFAULT_PAGE_RATE_LIMIT,
              nodes: [{ __typename: 'IssueComment', id: 'C_1', body: 'x' }],
            },
          }),
      }),
    /unexpected shape \(node type\)/,
  );
});

test('fetchThreadReplies requests one aliased node(id:) per thread with its own last:N and returns replies', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args);
    return JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 100, resetAt: '2026-07-01T12:00:00Z' },
        t0: {
          __typename: 'PullRequestReviewThread',
          id: 'T1',
          comments: {
            nodes: [
              {
                id: 'C10',
                author: { login: 'bob' },
                createdAt: '2026-07-01T11:00:00Z',
                body: 'reply',
              },
            ],
          },
        },
        t1: {
          __typename: 'PullRequestReviewThread',
          id: 'T2',
          comments: {
            nodes: [
              {
                id: 'C20',
                author: { login: 'carol' },
                createdAt: '2026-07-01T11:01:00Z',
                body: 'r1',
              },
              { id: 'C21', author: null, createdAt: '2026-07-01T11:02:00Z', body: 'r2' },
            ],
          },
        },
      },
    });
  };
  const { rows, rateLimit } = fetchThreadReplies(
    [
      { id: 'T1', increment: 1 },
      { id: 'T2', increment: 2 },
    ],
    { exec },
  );
  const query = calls[0].find((a) => a.startsWith('query='));
  assert.match(query, /t0: node\(id: \$id0\)/);
  assert.match(query, /comments\(last: 1\)/);
  assert.match(query, /t1: node\(id: \$id1\)/);
  assert.match(query, /comments\(last: 2\)/);
  assert.deepEqual(rows, [
    {
      id: 'T1',
      replies: [{ id: 'C10', author: 'bob', createdAt: '2026-07-01T11:00:00Z', body: 'reply' }],
    },
    {
      id: 'T2',
      replies: [
        { id: 'C20', author: 'carol', createdAt: '2026-07-01T11:01:00Z', body: 'r1' },
        { id: 'C21', author: null, createdAt: '2026-07-01T11:02:00Z', body: 'r2' },
      ],
    },
  ]);
  assert.deepEqual(rateLimit, { cost: 1, remaining: 100, resetAt: '2026-07-01T12:00:00Z' });
});

test('fetchThreadReplies with an empty entries array makes no call', () => {
  const { rows, rateLimit } = fetchThreadReplies([], {
    exec: () => {
      throw new Error('must not call');
    },
  });
  assert.deepEqual(rows, []);
  assert.equal(rateLimit, null);
});

test('fetchThreadReplies rejects a non-positive increment', () => {
  assert.throws(() => fetchThreadReplies([{ id: 'T1', increment: 0 }], { exec: () => '' }));
});

test("fetchThreadReplies rejects an increment above GitHub's connection-argument cap", () => {
  assert.throws(
    () =>
      fetchThreadReplies([{ id: 'T1', increment: 101 }], {
        exec: () => {
          throw new Error('must not call');
        },
      }),
    /last/i,
  );
});
