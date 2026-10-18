// Team-reviewer scope fallback: a token without read:org cannot select
// `... on Team { combinedSlug }`, so PR fetches retry once without it.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fetchPRs, fetchPRsByNumber, fetchWatchedItems } from '../lib/gh.mjs';
import { NOOP_LOCK_DEPS } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';

const RATE = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };
const TEAM = '... on Team { combinedSlug }';
const LABEL = 'team-reviewers-unavailable';

function prNode(number, reviewers = [{ requestedReviewer: {} }]) {
  return {
    number,
    title: `pr ${number}`,
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    reviewRequests: { nodes: reviewers, pageInfo: { hasNextPage: false } },
  };
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return JSON.stringify({
    data: {
      rateLimit: RATE,
      repository: { items: { nodes, pageInfo: { hasNextPage, endCursor } } },
    },
  });
}

// The shape GitHub returns for a token without read:org. Real `gh api graphql`
// exits 1 on it, so the default runner throws with the body kept on `stdout`.
function scopeBody({ rateLimit = RATE, type = 'INSUFFICIENT_SCOPES', message } = {}) {
  return JSON.stringify({
    data: rateLimit ? { rateLimit } : null,
    errors: [
      {
        type,
        path: ['repository', 'items', 'nodes', 0, 'reviewRequests', 'requestedReviewer'],
        message:
          message ??
          "Your token has not been granted the required scopes to execute this query. The 'combinedSlug' field requires one of the following scopes: ['read:org', 'read:discussion'], but your token has only been granted the: ['repo'] scopes.",
      },
    ],
  });
}

function ghFailure(stdout) {
  const error = new Error('gh api failed: exit 1 -- gh: Your token has not been granted');
  error.stdout = stdout;
  return error;
}

function queryOf(args) {
  return args.find((arg) => arg.startsWith('query='));
}

// Rejects any query that still selects the Team fragment, then serves `pages`.
function scopedExec(pages, calls = []) {
  const exec = (_cmd, args) => {
    calls.push(queryOf(args));
    if (queryOf(args).includes(TEAM)) throw ghFailure(scopeBody());
    return pages.shift();
  };
  return { exec, calls };
}

test('a team-scope rejection retries without the Team fragment and reports team reviewers as ?', () => {
  const session = {};
  let progress = 0;
  const { exec, calls } = scopedExec([
    page([prNode(1, [{ requestedReviewer: {} }, { requestedReviewer: { login: 'octo' } }])]),
  ]);
  const { rows, rateLimit } = fetchPRs('o/r', { exec, session, onProgress: () => progress++ });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(TEAM));
  assert.ok(!calls[1].includes('combinedSlug'));
  assert.deepEqual(rows[0].reviewRequests, ['?', 'octo']);
  assert.equal(session.teamReviewersUnavailable, true);
  // The rejected attempt's reported cost counts toward the tick's spend.
  assert.deepEqual(rateLimit, { ...RATE, cost: 2 });
  assert.equal(progress, 2);
});

test('the downgrade is sticky across pages and phases of one session', () => {
  const session = {};
  const { exec, calls } = scopedExec([
    page([prNode(1)], true, 'c1'),
    page([prNode(2)]),
    page([{ ...prNode(3), updatedAt: '2026-07-01T11:00:00Z' }]),
  ]);
  const { rows } = fetchPRs('o/r', { exec, session, horizonCutoff: '2026-07-01T09:00:00Z' });
  assert.deepEqual(
    rows.map((row) => row.number),
    [1, 2, 3],
  );
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((query) => query.includes(TEAM)).length, 1);
  // A later fetch on the same session never re-probes.
  const later = scopedExec([page([prNode(4)])]);
  fetchPRs('o/r', { exec: later.exec, session });
  assert.equal(later.calls.length, 1);
  assert.ok(!later.calls[0].includes('combinedSlug'));
});

test('a rejection without a reported rateLimit still falls back and counts only the retry', () => {
  let first = true;
  const { rateLimit } = fetchPRs('o/r', {
    exec: () => {
      if (first) {
        first = false;
        // A runner that returns the body instead of throwing is handled too.
        return scopeBody({ rateLimit: null });
      }
      return page([prNode(1)]);
    },
  });
  assert.deepEqual(rateLimit, RATE);
});

// `--include` (server-time capture) puts HTTP headers before every body.
function withHeaders(exec) {
  const HEADERS = 'HTTP/2.0 200 OK\r\nDate: Wed, 01 Jul 2026 12:00:00 GMT\r\n\r\n';
  return (cmd, args) => {
    if (!args.includes('--include')) return exec(cmd, args);
    try {
      return HEADERS + exec(cmd, args);
    } catch (err) {
      throw ghFailure(HEADERS + err.stdout);
    }
  };
}

test('server-time capture parses the scope rejection behind HTTP headers', () => {
  const dates = [];
  const { exec, calls } = scopedExec([page([prNode(1)])]);
  const { rows } = fetchPRs('o/r', {
    exec: withHeaders(exec),
    onServerTime: (time) => dates.push(time),
  });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(dates, ['2026-07-01T12:00:00.000Z']);
});

test('non-scope GraphQL errors still fail the fetch without a retry', () => {
  for (const body of [
    scopeBody({ type: 'FORBIDDEN' }),
    scopeBody({ message: "The 'labels' field requires one of the following scopes: ['repo']" }),
    JSON.stringify({ errors: [{ message: 'boom' }] }),
  ]) {
    const session = {};
    let calls = 0;
    const thrown = ghFailure(body);
    assert.throws(
      () =>
        fetchPRs('o/r', {
          session,
          exec: () => {
            calls++;
            throw thrown;
          },
        }),
      (err) => err === thrown,
    );
    assert.equal(calls, 1);
    assert.equal(session.teamReviewersUnavailable, undefined);
  }
  assert.throws(
    () => fetchPRs('o/r', { exec: () => JSON.stringify({ errors: [{ message: 'boom' }] }) }),
    /returned errors: boom/,
  );
});

test('a scope rejection of the downgraded query is not retried again', () => {
  let calls = 0;
  assert.throws(
    () =>
      fetchPRs('o/r', {
        exec: () => {
          calls++;
          throw ghFailure(scopeBody());
        },
      }),
    /gh api failed/,
  );
  assert.equal(calls, 2);
});

test('targeted PR and watched-item fetches share the fallback and its session', () => {
  const session = {};
  const byNumber = scopedExec([
    JSON.stringify({ data: { rateLimit: RATE, repository: { pr3: prNode(3) } } }),
  ]);
  const { rows, rateLimit } = fetchPRsByNumber('o/r', [3], { exec: byNumber.exec, session });
  assert.equal(byNumber.calls.length, 2);
  assert.deepEqual(rows[0].reviewRequests, ['?']);
  assert.deepEqual(rateLimit, { ...RATE, cost: 2 });
  assert.equal(session.teamReviewersUnavailable, true);

  const watched = scopedExec([
    JSON.stringify({
      data: {
        rateLimit: RATE,
        repository: { pr5: { __typename: 'PullRequest', ...prNode(5) } },
      },
    }),
  ]);
  const result = fetchWatchedItems('o/r', [{ entity: 'pr', number: 5 }], {
    exec: watched.exec,
    session,
  });
  assert.equal(watched.calls.length, 1);
  assert.deepEqual(result.pr[0].reviewRequests, ['?']);

  const fresh = scopedExec([
    JSON.stringify({
      data: {
        rateLimit: RATE,
        repository: { pr5: { __typename: 'PullRequest', ...prNode(5) } },
      },
    }),
  ]);
  fetchWatchedItems('o/r', [{ entity: 'pr', number: 5 }], { exec: fresh.exec, session: {} });
  assert.equal(fresh.calls.length, 2);
});

test('with full scopes the Team fragment is fetched once and nothing is downgraded', () => {
  const session = {};
  const calls = [];
  const { rows } = fetchPRs('o/r', {
    session,
    exec: (_cmd, args) => {
      calls.push(queryOf(args));
      return page([prNode(1, [{ requestedReviewer: { combinedSlug: 'org/team' } }])]);
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`... on Mannequin { login } ${TEAM}`));
  assert.deepEqual(rows[0].reviewRequests, ['org/team']);
  assert.deepEqual(session, {});
});

function detectorDeps(onPrFetch, calls = []) {
  const stored = new Map();
  return {
    ...NOOP_LOCK_DEPS,
    fetchPRs: (repo, opts) => {
      onPrFetch?.(opts);
      const { exec } = scopedExec([page([prNode(1)])], calls);
      return fetchPRs(repo, { ...opts, exec: withHeaders(exec) });
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE }),
    readSnapshot: (path) => stored.get(path) ?? null,
    writeSnapshotAtomic: (path, data) => {
      stored.set(path, data);
    },
    now: () => '2026-07-01T12:00:00Z',
    env: { GH_DELTA_NO_REGISTRY: '1' },
  };
}

test('the detector surfaces the downgrade as a warning and counts the rejected request', () => {
  const sessions = [];
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/team-scope.json'],
    detectorDeps((opts) => sessions.push(opts.session)),
  );
  assert.equal(code, 0);
  assert.ok(sessions[0] && typeof sessions[0] === 'object');
  const warning = report.warnings.find((entry) => entry.label === LABEL);
  assert.match(warning.reason, /read:org/);
  assert.equal(report.results[0].rateLimit.cost, 3);
});

for (const format of ['compact', 'ndjson', 'text']) {
  test(`the ${format} format carries the team-reviewers warning`, async () => {
    const result = await runCommand(
      [
        '--repo',
        'o/r',
        '--monitor-id',
        'main',
        '--state-file',
        `/tmp/team-scope-${format}.json`,
        '--format',
        format,
      ],
      detectorDeps(),
    );
    assert.equal(result.code, 0);
    assert.match(result.output, new RegExp(LABEL));
  });
}

test('a multi-repo run pays the rejected request once and warns per repository', () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'gd-team-scope-'));
  const { report } = run(
    ['--repo', 'o/a', '--repo', 'o/b', '--monitor-id', 'main', '--state-dir', dir],
    detectorDeps(undefined, calls),
  );
  assert.equal(calls.filter((query) => query.includes(TEAM)).length, 1);
  assert.deepEqual(
    report.warnings.map((warning) => warning.label).filter((label) => label.endsWith(LABEL)),
    [`o/a: ${LABEL}`, `o/b: ${LABEL}`],
  );
  assert.equal(report.results[0].rateLimit.cost, 3);
  assert.equal(report.results[1].rateLimit.cost, 2);
});

test('a tick that fetched no PRs does not report the downgrade', () => {
  const { report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/team-scope-issues.json',
      '--entities',
      'issue',
    ],
    { ...detectorDeps(), ghSession: { teamReviewersUnavailable: true } },
  );
  assert.deepEqual(report.warnings, []);
});
