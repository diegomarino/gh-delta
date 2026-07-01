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

const defaultExec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function failIfTruncated(kind, rows, repo) {
  if (rows.length < FETCH_LIMIT) return;
  throw new Error(
    `GitHub ${kind} fetch for ${repo} returned ${FETCH_LIMIT} ${kind}; watch scope is too broad or results are truncated`,
  );
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
  return rows;
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
