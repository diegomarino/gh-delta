// GitHub CLI boundary. All child-process work lives here so detector logic stays pure.
import { execFileSync } from 'node:child_process';

/** Fields required to classify PR state, CI, review, comments, mergeability, and head changes. */
export const PR_FIELDS = [
  'number',
  'title',
  'state',
  'updatedAt',
  'isDraft',
  'statusCheckRollup',
  'reviewDecision',
  'latestReviews',
  'mergeable',
  'comments',
  'headRefOid',
].join(',');

/** Fields required to classify issue state, labels, comments, and update fallback changes. */
export const ISSUE_FIELDS = ['number', 'title', 'state', 'updatedAt', 'labels', 'comments'].join(
  ',',
);
const FETCH_LIMIT = 500;
const REVIEW_THREAD_PAGE_SIZE = 100;
const OPEN_PR_REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: ${REVIEW_THREAD_PAGE_SIZE}, after: $endCursor) {
      nodes {
        number
        reviewThreads(first: ${REVIEW_THREAD_PAGE_SIZE}) {
          totalCount
          nodes {
            isResolved
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`.trim();

const defaultExec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function failIfTruncated(kind, rows, repo) {
  if (rows.length < FETCH_LIMIT) return;
  throw new Error(
    `GitHub ${kind} fetch for ${repo} returned ${FETCH_LIMIT} ${kind}; watch scope is too broad or results are truncated`,
  );
}

function repoParts(repo) {
  const [owner, name, extra] = repo.split('/');
  if (!owner || !name || extra) throw new Error(`--repo must be in owner/name form; got "${repo}"`);
  return { owner, name };
}

function graphqlPages(out, repo) {
  const pages = JSON.parse(out);
  if (!Array.isArray(pages)) {
    throw new Error(`GitHub GraphQL reviewThreads fetch for ${repo} returned unexpected shape`);
  }
  return pages;
}

function reviewThreadSignalsFromPages(pages, repo) {
  const signals = new Map();
  for (const page of pages) {
    if (page?.errors?.length) {
      throw new Error(`GitHub GraphQL reviewThreads fetch for ${repo} returned errors`);
    }
    const pullRequests = page?.data?.repository?.pullRequests;
    if (!pullRequests || !Array.isArray(pullRequests.nodes)) {
      throw new Error(`GitHub GraphQL reviewThreads fetch for ${repo} returned unexpected shape`);
    }
    for (const pr of pullRequests.nodes) {
      const threads = pr?.reviewThreads;
      if (!threads || !Array.isArray(threads.nodes)) {
        throw new Error(`GitHub GraphQL reviewThreads fetch for ${repo} returned unexpected shape`);
      }
      if (threads.pageInfo?.hasNextPage) {
        throw new Error(
          `GitHub GraphQL reviewThreads fetch for ${repo} returned paginated reviewThreads for PR #${pr.number}; cannot count unresolved review threads safely`,
        );
      }
      signals.set(Number(pr.number), {
        reviewThreads: threads.totalCount ?? threads.nodes.length,
        unresolvedReviewThreads: threads.nodes.filter((thread) => thread?.isResolved === false)
          .length,
      });
    }
  }
  return signals;
}

export function fetchOpenPrReviewThreadSignals(repo, exec = defaultExec) {
  const { owner, name } = repoParts(repo);
  const out = exec('gh', [
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-f',
    `query=${OPEN_PR_REVIEW_THREADS_QUERY}`,
  ]);
  return reviewThreadSignalsFromPages(graphqlPages(out, repo), repo);
}

function enrichOpenPrReviewThreads(repo, rows, exec) {
  const openRows = rows.filter((row) => row.state === 'OPEN');
  if (openRows.length === 0) return rows;

  const signals = fetchOpenPrReviewThreadSignals(repo, exec);
  return rows.map((row) => {
    if (row.state !== 'OPEN') return row;
    const signal = signals.get(Number(row.number));
    if (!signal) {
      throw new Error(
        `GitHub GraphQL reviewThreads fetch for ${repo} did not return PR #${row.number}`,
      );
    }
    return { ...row, ...signal };
  });
}

/**
 * Fetch all observable PRs for a repository through the GitHub CLI.
 *
 * Throws when the hard limit is reached because a truncated list would corrupt
 * missing-object detection and snapshot continuity.
 */
export function fetchPRs(repo, exec = defaultExec) {
  // --state all and --limit 500 are correctness flags, not performance tuning.
  const out = exec('gh', [
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'all',
    '--limit',
    String(FETCH_LIMIT),
    '--json',
    PR_FIELDS,
  ]);
  const rows = JSON.parse(out);
  failIfTruncated('PRs', rows, repo);
  return enrichOpenPrReviewThreads(repo, rows, exec);
}

/**
 * Fetch all observable issues for a repository through the GitHub CLI.
 *
 * Throws when the hard limit is reached because a truncated list would corrupt
 * missing-object detection and snapshot continuity.
 */
export function fetchIssues(repo, exec = defaultExec) {
  // Keep issue fetching broad so closures and relabels remain observable.
  const out = exec('gh', [
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'all',
    '--limit',
    String(FETCH_LIMIT),
    '--json',
    ISSUE_FIELDS,
  ]);
  const rows = JSON.parse(out);
  failIfTruncated('issues', rows, repo);
  return rows;
}
