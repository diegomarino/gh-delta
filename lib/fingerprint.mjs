// Stable object fingerprints for change detection. These intentionally avoid
// storing large GitHub payloads such as full comment bodies. Comment totals come
// from GraphQL `totalCommentsCount` (PRs) or `comments` scalar (issues), so no
// saturation flag is needed.
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

/**
 * Strip detector-internal churn from a fingerprint so identity is comparable.
 *
 * `missing` / `missingTicks` are missing-lifecycle bookkeeping and `commentsOverflow`
 * is a legacy saturation flag; none describe the observed change, so they must not
 * influence either change comparison or the content-addressed delta id. When the
 * fingerprint carries PR review-context fields, absent thread counts are backfilled
 * to zero so an older snapshot compares equal to a current one.
 */
export function comparableFingerprint(fp) {
  if (!fp) return fp;
  let normalized = fp;
  for (const key of ['missing', 'missingTicks', 'commentsOverflow']) {
    if (Object.hasOwn(normalized, key)) {
      const { [key]: _dropped, ...rest } = normalized;
      normalized = rest;
    }
  }
  if (
    'ci' in normalized ||
    'review' in normalized ||
    'mergeable' in normalized ||
    'head' in normalized
  ) {
    if (!Object.hasOwn(normalized, 'reviewThreads'))
      normalized = { ...normalized, reviewThreads: 0 };
    if (!Object.hasOwn(normalized, 'unresolvedReviewThreads'))
      normalized = { ...normalized, unresolvedReviewThreads: 0 };
  }
  return normalized;
}

/**
 * Recursively key-sort an object so JSON serialization is order-independent.
 *
 * GitHub API key ordering must never change a fingerprint hash or a delta id.
 */
export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

/**
 * Build the identity object hashed into a delta's content-addressed `id`.
 *
 * When `to` is present the entity was observed this fetch, so identity keys on
 * the resulting observed state: `{ repo, entity, number, to }`. Because `to`
 * (including GitHub's `updatedAt` / `headRefOid`) is a property of the
 * observation and not of the observer's history, two monitors that see the same
 * current GitHub state emit the same id — cross-monitor idempotency.
 *
 * When `to` is null (the `missing` / `still-missing` / `presumed-deleted`
 * lifecycle) there is no observed state, so identity keys on the last-seen
 * `from` plus `classes` and `missingTicks` — the fields that distinguish the
 * three missing stages of the same object.
 *
 * `monitorId`, the report `at`, `title`, and any derived display fields are
 * deliberately excluded: the id addresses the observed change, not the observer.
 */
export function deltaIdentity(repo, delta) {
  const { entity, number } = delta;
  if (delta.to != null) {
    return { repo, entity, number, to: comparableFingerprint(delta.to) };
  }
  return {
    repo,
    entity,
    number,
    from: comparableFingerprint(delta.from),
    classes: delta.classes,
    missingTicks: delta.missingTicks,
  };
}

/**
 * Return the full sha256 hex (64 chars) of a canonicalized delta identity.
 *
 * Ids are compared, not typed, so favour collision headroom over brevity. Pair
 * with `deltaIdentity()` at the report-assembly layer where `repo` is in scope.
 */
export function deltaId(identity) {
  return sha256(JSON.stringify(stableValue(identity)));
}
