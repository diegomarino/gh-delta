// GitHub GraphQL boundary. All child-process work lives here so detector logic stays pure.
// Incremental contract: open items are fetched in full (missing-detection scope);
// everything else is discovered by UPDATED_AT DESC pagination cut at the snapshot horizon.
import { execFileSync } from 'node:child_process';

const PAGE_SIZE = 100;
const MAX_OPEN_PAGES = 10; // fail closed beyond 1000 open items per family
const MAX_UPDATED_PAGES = 30; // fail closed beyond 3000 updated items per tick
export const DEFAULT_GH_TIMEOUT_MS = 60000;

const PR_QUERY = `
query($owner: String!, $name: String!, $states: [PullRequestState!], $endCursor: String) {
  repository(owner: $owner, name: $name) {
    items: pullRequests(states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, first: ${PAGE_SIZE}, after: $endCursor) {
      nodes {
        number title state updatedAt isDraft mergeable reviewDecision totalCommentsCount headRefOid headRefName
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${PAGE_SIZE}) {
          nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
          pageInfo { hasNextPage }
        } } } } }
        latestReviews(first: ${PAGE_SIZE}) { nodes { id submittedAt state author { login } commit { oid } } pageInfo { hasNextPage } }
        reviewThreads(first: ${PAGE_SIZE}) { totalCount nodes { isResolved } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

const ISSUE_QUERY = `
query($owner: String!, $name: String!, $states: [IssueState!], $endCursor: String) {
  repository(owner: $owner, name: $name) {
    items: issues(states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, first: ${PAGE_SIZE}, after: $endCursor) {
      nodes {
        number title state updatedAt
        labels(first: ${PAGE_SIZE}) { nodes { name } pageInfo { hasNextPage } }
        comments { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

const defaultExec = (cmd, args, { timeoutMs = DEFAULT_GH_TIMEOUT_MS } = {}) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Capture gh's stderr into the thrown message instead of leaking it raw to the
    // terminal; timeouts get a stable, greppable reason.
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const reason =
      err?.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err);
    throw new Error(`gh ${args[0]} failed: ${reason}${stderr ? ` -- ${stderr}` : ''}`);
  }
};

function repoParts(repo) {
  const [owner, name, extra] = repo.split('/');
  if (!owner || !name || extra) throw new Error(`--repo must be in owner/name form; got "${repo}"`);
  return { owner, name };
}

function graphqlPage(repo, query, variables, exec, opts) {
  const args = ['api', 'graphql'];
  for (const [key, value] of Object.entries(variables)) {
    if (value == null) continue;
    if (Array.isArray(value)) for (const item of value) args.push('-F', `${key}[]=${item}`);
    else args.push('-F', `${key}=${value}`);
  }
  args.push('-f', `query=${query}`);
  const body = JSON.parse(exec('gh', args, opts));
  if (body?.errors?.length) {
    throw new Error(
      `GitHub GraphQL fetch for ${repo} returned errors: ${body.errors[0]?.message ?? 'unknown'}`,
    );
  }
  const items = body?.data?.repository?.items;
  if (!items || !Array.isArray(items.nodes)) {
    throw new Error(`GitHub GraphQL fetch for ${repo} returned unexpected shape`);
  }
  return items;
}

/**
 * Walk UPDATED_AT DESC pages, stopping at the cutoff or the page cap.
 * ISO-8601 UTC timestamps compare correctly as strings. GitHub returns second-precision
 * `...Z` timestamps while a cutoff may carry milliseconds (`.000Z`); mixed formats compare
 * in the safe over-inclusive direction (items at the boundary are re-fetched, and unchanged
 * re-fetched items diff to zero deltas).
 */
function walk(repo, query, { owner, name, states, cutoff, maxPages, phase }, exec, opts) {
  const rows = [];
  let endCursor = null;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const items = graphqlPage(repo, query, { owner, name, states, endCursor }, exec, opts);
    for (const node of items.nodes) {
      if (cutoff && node.updatedAt < cutoff) return rows;
      rows.push(node);
    }
    if (!items.pageInfo?.hasNextPage) return rows;
    endCursor = items.pageInfo.endCursor;
  }
  throw new Error(
    `GitHub ${phase} fetch for ${repo} exceeded ${maxPages} pages; narrow the monitor scope or re-seed the baseline`,
  );
}

function assertComplete(connection, label, repo, number) {
  if (connection?.pageInfo?.hasNextPage) {
    throw new Error(
      `GitHub fetch for ${repo} returned paginated ${label} for #${number}; cannot fingerprint safely`,
    );
  }
}

function normalizePr(node, repo) {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  assertComplete(contexts, 'statusCheckRollup', repo, node.number);
  assertComplete(node.latestReviews, 'latestReviews', repo, node.number);
  assertComplete(node.reviewThreads, 'reviewThreads', repo, node.number);
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft ?? false,
    mergeable: node.mergeable ?? 'UNKNOWN',
    reviewDecision: node.reviewDecision ?? '',
    statusCheckRollup: (contexts?.nodes ?? []).filter(Boolean),
    latestReviews: (node.latestReviews?.nodes ?? []).filter(Boolean),
    totalCommentsCount: node.totalCommentsCount ?? 0,
    headRefOid: node.headRefOid ?? '',
    // Contextual metadata (not fingerprinted). Null after the head branch is
    // deleted post-merge; never throw on its absence.
    headRefName: node.headRefName ?? null,
    reviewThreads: node.reviewThreads?.totalCount ?? 0,
    unresolvedReviewThreads: (node.reviewThreads?.nodes ?? []).filter(
      (thread) => thread?.isResolved === false,
    ).length,
  };
}

function normalizeIssue(node, repo) {
  assertComplete(node.labels, 'labels', repo, node.number);
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    updatedAt: node.updatedAt,
    labels: (node.labels?.nodes ?? []).filter(Boolean),
    comments: node.comments?.totalCount ?? 0,
  };
}

/**
 * Fetch one entity family in two phases and merge them by number.
 *
 * Phase 1 pages all currently-open items in full -- this is the missing-detection
 * scope, so anything the detector believes is open but does not see here can be
 * flagged missing. Phase 2 (skipped at baseline, when `horizonCutoff` is null)
 * pages UPDATED_AT DESC across all states down to the horizon, which is how
 * MERGED/CLOSED transitions and comment/label churn are observed cheaply. The
 * open phase wins on collision so a full open node is never shadowed by a
 * horizon node for the same number.
 */
function fetchFamily(repo, query, openStates, normalize, { exec, timeoutMs, horizonCutoff }) {
  const { owner, name } = repoParts(repo);
  const opts = { timeoutMs };
  const rows = new Map();
  const open = walk(
    repo,
    query,
    {
      owner,
      name,
      states: openStates,
      cutoff: null,
      maxPages: MAX_OPEN_PAGES,
      phase: 'open items',
    },
    exec,
    opts,
  );
  for (const node of open) rows.set(node.number, node);
  if (horizonCutoff) {
    // states: null omits the variable so GitHub applies no state filter (all states returned),
    // which is required to observe MERGED/CLOSED transitions in the updated-items phase.
    const updated = walk(
      repo,
      query,
      {
        owner,
        name,
        states: null,
        cutoff: horizonCutoff,
        maxPages: MAX_UPDATED_PAGES,
        phase: 'updated items',
      },
      exec,
      opts,
    );
    for (const node of updated) if (!rows.has(node.number)) rows.set(node.number, node);
  }
  return [...rows.values()].map((node) => normalize(node, repo));
}

/**
 * Fetch observable PRs: all open ones, plus (when a horizon exists) everything
 * updated since the horizon. `horizonCutoff: null` means baseline: open only.
 */
export function fetchPRs(repo, options = {}) {
  const { exec = defaultExec, timeoutMs = DEFAULT_GH_TIMEOUT_MS, horizonCutoff = null } = options;
  return fetchFamily(repo, PR_QUERY, ['OPEN'], normalizePr, { exec, timeoutMs, horizonCutoff });
}

/**
 * Fetch observable issues with the same open + updated-since-horizon contract.
 */
export function fetchIssues(repo, options = {}) {
  const { exec = defaultExec, timeoutMs = DEFAULT_GH_TIMEOUT_MS, horizonCutoff = null } = options;
  return fetchFamily(repo, ISSUE_QUERY, ['OPEN'], normalizeIssue, {
    exec,
    timeoutMs,
    horizonCutoff,
  });
}
