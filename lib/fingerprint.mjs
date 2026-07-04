// Stable object fingerprints for change detection. These intentionally avoid
// storing large GitHub payloads such as full comment bodies. Comment totals come
// from GraphQL `totalCommentsCount` (PRs) or `comments` scalar (issues), so no
// saturation flag is needed.
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * Truncate SHA-1 outputs for compact stable fingerprints.
 */
// The shortened value is enough for drift-detection comparisons while keeping
// snapshot files smaller and diffs easier to read.

/**
 * Return an order-independent hash for GitHub check runs and status contexts.
 *
 * GitHub can mix CheckRun `{name,status,conclusion}` objects and StatusContext
 * `{context,state}` objects in the same rollup. Normalizing both shapes keeps
 * harmless API ordering changes from producing phantom CI deltas.
 */
export function canonicalizeCiRollup(statusCheckRollup = []) {
  const tuples = (statusCheckRollup ?? []).map((c) => {
    const name = c.name ?? c.context ?? '';
    const status = c.status ?? c.state ?? '';
    const conclusion = c.conclusion ?? c.state ?? '';
    return `${name}:${status}:${conclusion}`;
  });
  tuples.sort();
  return sha1(tuples.join('|'));
}

/**
 * Return an order-independent hash of the latest review activity.
 *
 * The hash includes review identity, timestamp, author, state, and commit so a
 * same-author follow-up review with the same state is still observable.
 */
export function hashReviews(latestReviews = []) {
  const tuples = (latestReviews ?? []).map(
    (r) =>
      `${r.id ?? ''}:${r.submittedAt ?? ''}:${r.author?.login ?? '?'}:${r.state ?? ''}:${r.commit?.oid ?? ''}`,
  );
  tuples.sort();
  return sha1(tuples.join('|'));
}

/**
 * Build the stable subset of a pull request used for delta detection.
 *
 * Large fields such as comment bodies are deliberately excluded; the detector
 * stores only enough signal to classify state, CI, review, mergeability,
 * comment-count, and head-SHA changes.
 */
export function prFingerprint(pr) {
  return {
    state: pr.state,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft ?? false,
    ci: canonicalizeCiRollup(pr.statusCheckRollup),
    review: pr.reviewDecision ?? '',
    reviews: hashReviews(pr.latestReviews),
    mergeable: pr.mergeable ?? 'UNKNOWN',
    comments: pr.totalCommentsCount ?? 0,
    reviewThreads: pr.reviewThreads ?? 0,
    unresolvedReviewThreads: pr.unresolvedReviewThreads ?? 0,
    head: pr.headRefOid ?? '',
  };
}

/**
 * Build the stable subset of an issue used for delta detection.
 *
 * Labels are sorted before storage so GitHub API ordering does not change the
 * snapshot fingerprint.
 */
export function issueFingerprint(issue) {
  return {
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: (issue.labels ?? []).map((l) => l.name).sort(),
    comments: issue.comments ?? 0,
  };
}
