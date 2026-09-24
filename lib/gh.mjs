// GitHub GraphQL boundary. All child-process work lives here so detector logic stays pure.
// Incremental contract: open items are fetched in full (missing-detection scope);
// everything else is discovered by UPDATED_AT DESC pagination cut at the snapshot horizon.
import { execFileSync } from 'node:child_process';

const PAGE_SIZE = 100;
const MAX_OPEN_PAGES = 10; // fail closed beyond 1000 open items per family
const MAX_UPDATED_PAGES = 30; // fail closed beyond 3000 updated items per tick
export const DEFAULT_GH_TIMEOUT_MS = 60000;

/**
 * Read the GraphQL quota reported by GitHub's REST rate-limit endpoint.
 * The CLI owns policy; this boundary only executes, validates, and normalizes.
 */
export function fetchRateLimit(options = {}) {
  const { exec = defaultExec, timeoutMs = DEFAULT_GH_TIMEOUT_MS, onProgress } = options;
  let body;
  try {
    const output = exec('gh', ['api', 'rate_limit'], { timeoutMs });
    // Keep the lock alive after a completed subprocess even if its response is
    // malformed. A process failure deliberately makes no progress.
    onProgress?.();
    body = JSON.parse(output);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('GitHub rate-limit returned invalid JSON');
    throw err;
  }
  const graphql = body?.resources?.graphql;
  const remaining = graphql?.remaining;
  const reset = graphql?.reset;
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    !Number.isSafeInteger(reset) ||
    reset < 0
  )
    throw new Error('GitHub rate-limit returned unexpected shape');
  const resetDate = new Date(reset * 1000);
  if (!Number.isFinite(resetDate.getTime()))
    throw new Error('GitHub rate-limit returned unexpected shape');
  return { remaining, resetAt: resetDate.toISOString() };
}

const PR_FIELDS = `
        number title state updatedAt isDraft mergeable mergeStateStatus reviewDecision totalCommentsCount headRefOid headRefName baseRefName
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${PAGE_SIZE}) {
          nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state } }
          pageInfo { hasNextPage }
        } } } } }
        latestReviews(first: ${PAGE_SIZE}) { nodes { id submittedAt state author { login } commit { oid } } pageInfo { hasNextPage } }
        comments(last: 5) { totalCount nodes { id author { login } } }
        reviewThreads(first: ${PAGE_SIZE}) { totalCount nodes { id isResolved } pageInfo { hasNextPage } }
        labels(first: ${PAGE_SIZE}) { nodes { name } pageInfo { hasNextPage } }
        assignees(first: ${PAGE_SIZE}) { nodes { login } pageInfo { hasNextPage } }
        reviewRequests(first: ${PAGE_SIZE}) { nodes { requestedReviewer {
          ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug }
        } } pageInfo { hasNextPage } }
`.trim();

const PR_QUERY = `
query($owner: String!, $name: String!, $states: [PullRequestState!], $endCursor: String) {
  repository(owner: $owner, name: $name) {
    items: pullRequests(states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, first: ${PAGE_SIZE}, after: $endCursor) {
      nodes {
        ${PR_FIELDS}
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
        assignees(first: ${PAGE_SIZE}) { nodes { login } pageInfo { hasNextPage } }
        comments(last: 5) { totalCount nodes { id author { login } } }
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
    // Every GraphQL variable here is a String!/enum, so pass them with -f (raw
    // string). -F applies gh's "magic" type coercion, turning slugs like `2048`
    // or `true` into non-strings that GitHub then rejects for the typed variable.
    if (Array.isArray(value)) for (const item of value) args.push('-f', `${key}[]=${item}`);
    else args.push('-f', `${key}=${value}`);
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
 *
 * `onProgress`, when given, is called once after each page's `gh` call
 * returns successfully -- including the last page before returning, but never
 * after a page that throws. This is the hook the lock's deadline extension
 * (see lib/lock.mjs's `extendLockDeadline` and lib/cli.mjs's wiring) rides on:
 * a fetch that keeps completing pages keeps pushing its lease forward, and a
 * fetch that stops (hangs, or the process died) simply stops calling this and
 * lets the lease expire on schedule.
 */
function walk(
  repo,
  query,
  { owner, name, states, cutoff, maxPages, phase },
  exec,
  opts,
  onProgress,
) {
  const rows = [];
  let endCursor = null;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const items = graphqlPage(repo, query, { owner, name, states, endCursor }, exec, opts);
    onProgress?.();
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

// GraphQL `RequestedReviewer` is a union (User | Bot | Mannequin | Team); the
// selection aliases each variant to one name-ish scalar. Teams surface as
// `combinedSlug` (org/team), everything else as `login`.
function requestedReviewerName(node) {
  const reviewer = node?.requestedReviewer;
  return reviewer?.login ?? reviewer?.combinedSlug ?? '?';
}

function assigneeLogins(assignees) {
  return (assignees?.nodes ?? []).filter(Boolean).map((a) => a.login ?? '?');
}

function normalizePr(node, repo) {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  assertComplete(contexts, 'statusCheckRollup', repo, node.number);
  assertComplete(node.latestReviews, 'latestReviews', repo, node.number);
  assertComplete(node.reviewThreads, 'reviewThreads', repo, node.number);
  assertComplete(node.labels, 'labels', repo, node.number);
  assertComplete(node.assignees, 'assignees', repo, node.number);
  assertComplete(node.reviewRequests, 'reviewRequests', repo, node.number);
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft ?? false,
    mergeable: node.mergeable ?? 'UNKNOWN',
    // Observed here so the summary layer reads it from the same fetch as the
    // fingerprint. Stored raw and compared like any other fingerprint field
    // (see lib/fingerprint.mjs), so a CLEAN->BEHIND-only transition is
    // observable rather than silently dropped.
    mergeStateStatus: node.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: node.reviewDecision ?? '',
    statusCheckRollup: (contexts?.nodes ?? []).filter(Boolean),
    latestReviews: (node.latestReviews?.nodes ?? []).filter(Boolean),
    totalCommentsCount: node.totalCommentsCount ?? 0,
    conversationComments: node.comments?.totalCount ?? 0,
    commentNodes: (node.comments?.nodes ?? []).map((comment) => ({
      id: comment?.id ?? null,
      author: comment?.author?.login ?? null,
    })),
    headRefOid: node.headRefOid ?? '',
    // Contextual metadata (not fingerprinted). GitHub's `headRefName` is a
    // non-null `String!` and is retained even after the branch is deleted, so
    // this is effectively always a string; `?? null` is purely defensive.
    headRefName: node.headRefName ?? null,
    reviewThreads: node.reviewThreads?.totalCount ?? 0,
    unresolvedReviewThreads: (node.reviewThreads?.nodes ?? []).filter(
      (thread) => thread?.isResolved === false,
    ).length,
    // Raw per-thread identity + resolution state, carried through so the
    // fingerprint layer can build an identity digest (see hashReviewThreads in
    // lib/fingerprint.mjs). Threads without an id (older fixtures, defensive
    // only) are dropped; they cannot be told apart across ticks anyway.
    reviewThreadNodes: (node.reviewThreads?.nodes ?? [])
      .filter((thread) => thread?.id)
      .map((thread) => ({ id: thread.id, isResolved: thread.isResolved === true })),
    // GitHub retains `baseRefName` (String!) even after base deletion; '' is defensive.
    baseRefName: node.baseRefName ?? '',
    labels: (node.labels?.nodes ?? []).filter(Boolean),
    assignees: assigneeLogins(node.assignees),
    reviewRequests: (node.reviewRequests?.nodes ?? []).filter(Boolean).map(requestedReviewerName),
  };
}

function normalizeIssue(node, repo) {
  assertComplete(node.labels, 'labels', repo, node.number);
  assertComplete(node.assignees, 'assignees', repo, node.number);
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    updatedAt: node.updatedAt,
    labels: (node.labels?.nodes ?? []).filter(Boolean),
    assignees: assigneeLogins(node.assignees),
    comments: node.comments?.totalCount ?? 0,
    conversationComments: node.comments?.totalCount ?? 0,
    commentNodes: (node.comments?.nodes ?? []).map((comment) => ({
      id: comment?.id ?? null,
      author: comment?.author?.login ?? null,
    })),
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
function fetchFamily(
  repo,
  query,
  openStates,
  normalize,
  { exec, timeoutMs, horizonCutoff, onProgress },
) {
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
    onProgress,
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
      onProgress,
    );
    for (const node of updated) if (!rows.has(node.number)) rows.set(node.number, node);
  }
  return [...rows.values()].map((node) => normalize(node, repo));
}

/**
 * Fetch observable PRs: all open ones, plus (when a horizon exists) everything
 * updated since the horizon. `horizonCutoff: null` means baseline: open only.
 * `onProgress`, when given, is called after each completed pagination page --
 * see `walk`'s doc comment; lib/cli.mjs uses this to extend the run's lock
 * lease as long as the fetch keeps making progress.
 */
export function fetchPRs(repo, options = {}) {
  const {
    exec = defaultExec,
    timeoutMs = DEFAULT_GH_TIMEOUT_MS,
    horizonCutoff = null,
    onProgress,
  } = options;
  return fetchFamily(repo, PR_QUERY, ['OPEN'], normalizePr, {
    exec,
    timeoutMs,
    horizonCutoff,
    onProgress,
  });
}

/**
 * Fetch a small, explicit PR universe in one GraphQL request. This deliberately
 * shares `PR_FIELDS` and `normalizePr` with broad polling so targeted snapshots
 * retain exactly the same observation contract.
 */
export function fetchPRsByNumber(repo, numbers, options = {}) {
  const { exec = defaultExec, timeoutMs = DEFAULT_GH_TIMEOUT_MS, onProgress } = options;
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  if (!unique.length) return [];
  if (!unique.every((number) => Number.isSafeInteger(number) && number > 0))
    throw new Error('targeted PR fetch requires positive integer numbers');
  const { owner, name } = repoParts(repo);
  const variables = unique.map((number) => `$n${number}: Int!`).join(', ');
  const selections = unique
    .map((number) => `pr${number}: pullRequest(number: $n${number}) { ${PR_FIELDS} }`)
    .join('\n');
  const query = `query($owner: String!, $name: String!, ${variables}) { repository(owner: $owner, name: $name) { ${selections} } }`;
  const args = ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`];
  for (const number of unique) args.push('-F', `n${number}=${number}`);
  args.push('-f', `query=${query}`);
  let body;
  try {
    body = JSON.parse(exec('gh', args, { timeoutMs }));
  } catch (err) {
    if (err instanceof SyntaxError)
      throw new Error(`GitHub GraphQL fetch for ${repo} returned invalid JSON`);
    throw err;
  }
  if (body?.errors?.length) {
    throw new Error(
      `GitHub GraphQL fetch for ${repo} returned errors: ${body.errors[0]?.message ?? 'unknown'}`,
    );
  }
  const repository = body?.data?.repository;
  if (!repository || typeof repository !== 'object')
    throw new Error(`GitHub GraphQL fetch for ${repo} returned unexpected shape`);
  const rows = [];
  for (const number of unique) {
    const node = repository[`pr${number}`];
    if (node === null) continue;
    if (!node || typeof node !== 'object' || node.number !== number)
      throw new Error(`GitHub GraphQL fetch for ${repo} returned unexpected shape`);
    rows.push(normalizePr(node, repo));
  }
  onProgress?.();
  return rows;
}

/**
 * Fetch observable issues with the same open + updated-since-horizon contract.
 */
export function fetchIssues(repo, options = {}) {
  const {
    exec = defaultExec,
    timeoutMs = DEFAULT_GH_TIMEOUT_MS,
    horizonCutoff = null,
    onProgress,
  } = options;
  return fetchFamily(repo, ISSUE_QUERY, ['OPEN'], normalizeIssue, {
    exec,
    timeoutMs,
    horizonCutoff,
    onProgress,
  });
}

// Body enrichment is intentionally a separate, opt-in nodes query.  It is
// called only after a snapshot has been published; keeping it here makes the
// GitHub process boundary mockable and prevents detector logic from acquiring
// an accidental network dependency.
const ENRICHMENT_KINDS = new Set(['review', 'comments', 'threads']);
const ENRICHMENT_FRAGMENTS = {
  review: `... on PullRequestReview { id body state submittedAt author { login } commit { oid } }`,
  comments: `... on IssueComment { id body createdAt author { login } }`,
  threads: `... on PullRequestReviewThread { id comments(first: 1) { nodes { id body createdAt author { login } path line originalLine } pageInfo { hasNextPage } } }`,
};
const ENRICHMENT_TYPENAMES = {
  review: 'PullRequestReview',
  comments: 'IssueComment',
  threads: 'PullRequestReviewThread',
};

function nullableString(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new Error(`GitHub enrichment returned unexpected shape (${label})`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string')
    throw new Error(`GitHub enrichment returned unexpected shape (${label})`);
  return value;
}

function nullableInteger(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value))
    throw new Error(`GitHub enrichment returned unexpected shape (${label})`);
  return value;
}

function normalizedAuthor(author) {
  if (author === null) return null;
  if (!author || typeof author !== 'object')
    throw new Error('GitHub enrichment returned unexpected shape (author)');
  return nullableString(author.login, 'author.login');
}

function normalizeEnrichmentNode(kind, node) {
  if (!node || typeof node !== 'object' || node.__typename !== ENRICHMENT_TYPENAMES[kind])
    throw new Error('GitHub enrichment returned unexpected shape (node type)');
  const id = requiredString(node.id, 'id');
  if (kind === 'review') {
    const commit = node.commit;
    if (commit !== null && (!commit || typeof commit !== 'object'))
      throw new Error('GitHub enrichment returned unexpected shape (commit)');
    return {
      id,
      author: normalizedAuthor(node.author),
      state: requiredString(node.state, 'state'),
      submittedAt: nullableString(node.submittedAt, 'submittedAt'),
      commit: commit === null ? null : nullableString(commit.oid, 'commit.oid'),
      body: requiredString(node.body, 'body'),
    };
  }
  if (kind === 'comments') {
    return {
      id,
      author: normalizedAuthor(node.author),
      createdAt: requiredString(node.createdAt, 'createdAt'),
      body: requiredString(node.body, 'body'),
    };
  }
  const connection = node.comments;
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    connection.nodes.length !== 1 ||
    connection.pageInfo?.hasNextPage !== false
  ) {
    throw new Error('GitHub enrichment returned unexpected shape (thread comments)');
  }
  const first = connection.nodes[0];
  if (!first || typeof first !== 'object')
    throw new Error('GitHub enrichment returned unexpected shape (thread first comment)');
  return {
    id,
    firstComment: {
      id: requiredString(first.id, 'thread comment id'),
      author: normalizedAuthor(first.author),
      createdAt: requiredString(first.createdAt, 'thread comment createdAt'),
      path: nullableString(first.path, 'thread comment path'),
      line: nullableInteger(first.line, 'thread comment line'),
      originalLine: nullableInteger(first.originalLine, 'thread comment originalLine'),
      body: requiredString(first.body, 'thread comment body'),
    },
  };
}

/** Fetch normalized bodies for one enrichment kind in exactly one nodes query. */
export function fetchEnrichment(kind, ids, options = {}) {
  if (!ENRICHMENT_KINDS.has(kind)) throw new Error(`unknown enrichment kind "${kind}"`);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0))
    throw new Error('enrichment ids must be non-empty strings');
  const requested = [...new Set(ids)].sort();
  if (requested.length === 0) return [];
  const { exec = defaultExec, timeoutMs = DEFAULT_GH_TIMEOUT_MS, onProgress } = options;
  const args = ['api', 'graphql'];
  for (const id of requested) args.push('-f', `ids[]=${id}`);
  args.push(
    '-f',
    `query=query($ids: [ID!]!) { nodes(ids: $ids) { __typename ${ENRICHMENT_FRAGMENTS[kind]} } }`,
  );
  let body;
  try {
    const output = exec('gh', args, { timeoutMs });
    // A completed process extends the lock even if its JSON payload later
    // fails validation; only a thrown process call counts as no progress.
    onProgress?.();
    body = JSON.parse(output);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('GitHub enrichment returned invalid JSON');
    throw err;
  }
  if (body?.errors?.length)
    throw new Error(`GitHub enrichment returned errors: ${body.errors[0]?.message ?? 'unknown'}`);
  if (!Array.isArray(body?.data?.nodes))
    throw new Error('GitHub enrichment returned unexpected shape');
  const rows = body.data.nodes.map((node) => normalizeEnrichmentNode(kind, node));
  const found = new Map();
  for (const row of rows) {
    if (found.has(row.id))
      throw new Error('GitHub enrichment returned unexpected shape (duplicate node)');
    found.set(row.id, row);
  }
  if (found.size !== requested.length || requested.some((id) => !found.has(id)))
    throw new Error('GitHub enrichment returned incomplete requested-id coverage');
  return requested.map((id) => found.get(id));
}
