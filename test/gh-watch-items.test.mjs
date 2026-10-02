// Targeted issue and mixed GraphQL fetches. Hermetic: the exec double is the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWatchedItems } from '../lib/gh.mjs';

const RATE = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };

function issueNode(over = {}) {
  return {
    __typename: 'Issue',
    number: 42,
    title: 'design',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    id: 'I_42',
    author: { login: 'octocat' },
    createdAt: '2026-06-01T00:00:00Z',
    url: 'https://github.com/o/r/issues/42',
    labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } },
    assignees: { nodes: [{ login: 'ada' }], pageInfo: { hasNextPage: false } },
    comments: { totalCount: 1, nodes: [{ id: 'C1', author: { login: 'ada' } }] },
    ...over,
  };
}

function prNode(number) {
  return {
    __typename: 'PullRequest',
    number,
    title: `pr ${number}`,
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'REVIEW_REQUIRED',
    totalCommentsCount: 0,
    headRefOid: 'abc',
    headRefName: 'feature',
    baseRefName: 'main',
    id: `PR_${number}`,
    author: { login: 'octocat' },
    createdAt: '2026-06-01T00:00:00Z',
    url: `https://github.com/o/r/pull/${number}`,
    commits: { nodes: [] },
    latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    assignees: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
  };
}

function body(repository) {
  return JSON.stringify({ data: { rateLimit: RATE, repository } });
}

test('mixed targeted fetch uses one ordered alias query and the issue normalizer', () => {
  const calls = [];
  const { pr, issue, rateLimit } = fetchWatchedItems(
    'o/r',
    [
      { entity: 'issue', number: 42 },
      { entity: 'pr', number: 3 },
      { entity: 'issue', number: 42 },
      { entity: 'pr', number: 9 },
    ],
    {
      exec: (_cmd, args) => {
        calls.push(args);
        return body({
          pr3: prNode(3),
          pr9: prNode(9),
          issue42: issueNode(),
        });
      },
    },
  );
  assert.equal(calls.length, 1);
  const query = calls[0].find((arg) => arg.startsWith('query='));
  assert.match(query, /pr3: pullRequest\(number: \$pr3\)/);
  assert.match(query, /pr9: pullRequest\(number: \$pr9\)/);
  assert.match(query, /issue42: issue\(number: \$issue42\)/);
  assert.equal(query.includes('issues('), false);
  assert.equal(query.includes('pullRequests('), false);
  assert.ok(query.indexOf('pr3:') < query.indexOf('pr9:'));
  assert.ok(query.indexOf('pr9:') < query.indexOf('issue42:'));
  assert.deepEqual(
    pr.map((row) => row.number),
    [3, 9],
  );
  assert.equal(pr[0].headSha, 'abc');
  assert.equal(issue.length, 1);
  assert.equal(issue[0].number, 42);
  assert.equal(issue[0].state, 'open');
  assert.deepEqual(issue[0].labels, [{ name: 'bug' }]);
  assert.deepEqual(issue[0].assignees, ['ada']);
  assert.equal(issue[0].conversationComments, 1);
  assert.equal(issue[0].headSha, undefined);
  assert.equal(issue[0].isDraft, undefined);
  assert.deepEqual(rateLimit, RATE);
});

test('targeted watch fetch treats null as missing and rejects malformed or wrong-type aliases', () => {
  const missing = fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
    exec: () => body({ issue42: null }),
  });
  assert.deepEqual(missing, { pr: [], issue: [], rateLimit: RATE });

  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
        exec: () => body({}),
      }),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      fetchWatchedItems(
        'o/r',
        [
          { entity: 'pr', number: 3 },
          { entity: 'issue', number: 42 },
        ],
        {
          exec: () => body({ pr3: prNode(3) }),
        },
      ),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
        exec: () =>
          JSON.stringify({
            errors: [{ message: 'boom' }],
            data: { rateLimit: RATE, repository: { issue42: issueNode() } },
          }),
      }),
    /returned errors: boom/,
  );
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
        exec: () => body({ issue42: { ...issueNode(), __typename: 'PullRequest' } }),
      }),
    /issue42 type/,
  );
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
        exec: () => body({ issue42: issueNode({ number: 7 }) }),
      }),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'pr', number: 3 }], {
        exec: () => body({ pr3: prNode(9) }),
      }),
    /unexpected shape/,
  );
  const overflow = issueNode();
  overflow.labels.pageInfo.hasNextPage = true;
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'issue', number: 42 }], {
        exec: () => body({ issue42: overflow }),
      }),
    /paginated labels/,
  );
  const prOverflow = prNode(3);
  prOverflow.reviewThreads.pageInfo.hasNextPage = true;
  assert.throws(
    () =>
      fetchWatchedItems('o/r', [{ entity: 'pr', number: 3 }], {
        exec: () => body({ pr3: prOverflow }),
      }),
    /paginated reviewThreads/,
  );
});

test('targeted watch fetch refuses more than ten items and skips the network when empty', () => {
  assert.deepEqual(fetchWatchedItems('o/r', [], { exec: () => assert.fail('must not fetch') }), {
    pr: [],
    issue: [],
    rateLimit: null,
  });
  assert.throws(
    () =>
      fetchWatchedItems(
        'o/r',
        Array.from({ length: 11 }, (_, index) => ({ entity: 'issue', number: index + 1 })),
        { exec: () => assert.fail('must not fetch') },
      ),
    /at most 10/,
  );
});
