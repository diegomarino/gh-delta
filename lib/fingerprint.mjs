// Stable object fingerprints for change detection. These intentionally avoid
// storing large GitHub payloads such as full comment bodies. Comment totals come
// from GraphQL `totalCommentsCount` (PRs) or `comments` scalar (issues), so no
// saturation flag is needed.
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const ciTuple = (row) => `${row.name}:${row.status}:${row.conclusion}`;

/**
 * Normalize a CI rollup into sorted `{name, status, conclusion}` rows.
 *
 * GitHub can mix CheckRun `{name,status,conclusion}` objects and StatusContext
 * `{context,state}` objects in the same rollup; both collapse to the same row
 * shape. This is the persisted summary that lets detail output name the exact
 * checks that changed, and the sole input to `canonicalizeCiRollup` so the
 * summary and the digest can never disagree.
 */
export function summarizeCiRollup(statusCheckRollup = []) {
  const rows = (statusCheckRollup ?? []).map((c) => ({
    name: c.name ?? c.context ?? '',
    status: c.status ?? c.state ?? '',
    conclusion: c.conclusion ?? c.state ?? '',
  }));
  // Sort by the composed tuple string, matching the pre-summary digest ordering
  // exactly so existing snapshot `ci` hashes stay byte-identical.
  rows.sort((a, b) => (ciTuple(a) < ciTuple(b) ? -1 : ciTuple(a) > ciTuple(b) ? 1 : 0));
  return rows;
}

/**
 * Return an order-independent hash for GitHub check runs and status contexts.
 *
 * Normalizing both rollup shapes keeps harmless API ordering changes from
 * producing phantom CI deltas.
 */
export function canonicalizeCiRollup(statusCheckRollup = []) {
  return sha1(summarizeCiRollup(statusCheckRollup).map(ciTuple).join('|'));
}

/**
 * Normalize latest reviews into sorted `{author, state, submittedAt, commit}` rows.
 *
 * This is the persisted compact review summary that gives detail output the
 * author/state context behind the opaque `reviews` digest. The review node id
 * is deliberately omitted: it adds no context an agent can act on.
 */
export function summarizeReviews(latestReviews = []) {
  const rows = (latestReviews ?? []).map((r) => ({
    author: r.author?.login ?? '?',
    state: r.state ?? '',
    submittedAt: r.submittedAt ?? '',
    commit: r.commit?.oid ?? '',
  }));
  rows.sort((a, b) => {
    const ka = `${a.author}:${a.submittedAt}:${a.state}:${a.commit}`;
    const kb = `${b.author}:${b.submittedAt}:${b.state}:${b.commit}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return rows;
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

const threadTuple = (row) => `${row.id}:${row.isResolved}`;

/**
 * Normalize review threads into sorted `{id, isResolved}` rows.
 *
 * This is the persisted per-thread state that lets the detector tell "thread A
 * resolved, thread B reopened" apart from "the totals happen to still match" --
 * a distinction the `reviewThreads`/`unresolvedReviewThreads` counters alone
 * cannot make. Threads without an id are dropped by the gh.mjs boundary before
 * this ever sees them.
 */
export function summarizeReviewThreads(reviewThreadNodes = []) {
  const rows = (reviewThreadNodes ?? [])
    .filter((t) => t?.id)
    .map((t) => ({ id: t.id, isResolved: t.isResolved === true }));
  rows.sort((a, b) =>
    threadTuple(a) < threadTuple(b) ? -1 : threadTuple(a) > threadTuple(b) ? 1 : 0,
  );
  return rows;
}

/**
 * Return an order-independent hash of review-thread identity + resolution state.
 *
 * Like `ci`/`reviews`, this digest is an ordinary `fingerprint` field (schema
 * v2 has no drop-list -- see lib/snapshot.mjs): it is compared like every
 * other field and does enter the content-addressed delta id. It still earns
 * its keep alongside `threadStates` (the summary it is hashed from) because a
 * same-count thread swap (one resolved, another reopened between ticks)
 * changes neither `reviewThreads` nor `unresolvedReviewThreads`, so the plain
 * counter comparison alone would miss it; `threadStates` participating in the
 * fingerprint's deep-equal is what still catches that swap, and the detector
 * additionally diffs `threadStates` identity-wise (see `threadSetDiff` in
 * lib/detect.mjs) to classify it precisely as added/resolved.
 */
export function hashReviewThreads(reviewThreadNodes = []) {
  return sha1(summarizeReviewThreads(reviewThreadNodes).map(threadTuple).join('|'));
}

/**
 * Build the stable subset of a pull request used for delta detection.
 *
 * Large fields such as comment bodies are deliberately excluded; the detector
 * stores only enough signal to classify state, CI, review, mergeability,
 * comment-count, and head-SHA changes.
 */
export function prFingerprint(pr) {
  const ciDetails = (pr.statusCheckRollup ?? [])
    .map((row) => ({
      name: row.name ?? row.context ?? '',
      status: row.status ?? row.state ?? '',
      conclusion: row.conclusion ?? row.state ?? '',
      ...(row.detailsUrl ? { detailsUrl: row.detailsUrl } : {}),
    }))
    .filter(
      (row) => row.detailsUrl && ['FAILURE', 'TIMED_OUT', 'CANCELLED'].includes(row.conclusion),
    );
  const reviewDetails = (pr.latestReviews ?? [])
    .map((row) => ({
      id: row.id,
      author: row.author?.login ?? '?',
      state: row.state ?? '',
      submittedAt: row.submittedAt ?? '',
      commit: row.commit?.oid ?? '',
    }))
    .filter((row) => row.id && row.state === 'CHANGES_REQUESTED');
  const commentNodes = (pr.commentNodes ?? []).map((row) => ({
    id: row?.id ?? null,
    author: row?.author ?? null,
  }));
  return {
    state: pr.state,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft ?? false,
    ci: canonicalizeCiRollup(pr.statusCheckRollup),
    ciChecks: summarizeCiRollup(pr.statusCheckRollup),
    ...(ciDetails.length ? { ciDetails } : {}),
    review: pr.reviewDecision ?? '',
    reviews: hashReviews(pr.latestReviews),
    reviewSummary: summarizeReviews(pr.latestReviews),
    ...(reviewDetails.length ? { reviewDetails } : {}),
    mergeable: pr.mergeable ?? 'UNKNOWN',
    mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
    comments: pr.totalCommentsCount ?? 0,
    ...(pr.conversationComments !== undefined
      ? { conversationComments: pr.conversationComments }
      : {}),
    ...(commentNodes.length ? { commentNodes } : {}),
    reviewThreads: pr.reviewThreads ?? 0,
    unresolvedReviewThreads: pr.unresolvedReviewThreads ?? 0,
    // Thread-identity digest/summary; ordinary compared fingerprint fields in
    // schema v2 (see hashReviewThreads' doc comment) -- they participate in
    // change comparison and the delta id like everything else here. Always
    // present, even when the input has no `reviewThreadNodes` (a PR with zero
    // threads, or a caller building PR-shaped objects that omit the field):
    // `hashReviewThreads`/`summarizeReviewThreads` both default an
    // absent/empty list to the empty-list digest/array, so this never needs a
    // presence guard on either side of a comparison.
    threadDigest: hashReviewThreads(pr.reviewThreadNodes),
    threadStates: summarizeReviewThreads(pr.reviewThreadNodes),
    head: pr.headRefOid ?? '',
    base: pr.baseRefName ?? '',
    labels: (pr.labels ?? []).map((l) => l.name).sort(),
    assignees: [...(pr.assignees ?? [])].sort(),
    reviewRequests: [...(pr.reviewRequests ?? [])].sort(),
  };
}

/**
 * Build the stable subset of an issue used for delta detection.
 *
 * Labels are sorted before storage so GitHub API ordering does not change the
 * snapshot fingerprint.
 */
export function issueFingerprint(issue) {
  const commentNodes = (issue.commentNodes ?? []).map((row) => ({
    id: row?.id ?? null,
    author: row?.author ?? null,
  }));
  return {
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: (issue.labels ?? []).map((l) => l.name).sort(),
    assignees: [...(issue.assignees ?? [])].sort(),
    comments: issue.comments ?? 0,
    ...(issue.conversationComments !== undefined
      ? { conversationComments: issue.conversationComments }
      : {}),
    ...(commentNodes.length ? { commentNodes } : {}),
  };
}

// v1 had a `comparableFingerprint` drop-list here (14 keys) plus an
// `ADDITIVE_COMPARED_FIELDS` upgrade-compat list, both needed because a single
// flat object mixed compared fields, detail-only mirrors, and detector
// bookkeeping. Schema v2's three-section item shape (fingerprint / context /
// meta -- see lib/snapshot.mjs) removes the need for either: `fingerprint` is
// exactly the compared fields, nothing to drop, and there is no legacy
// snapshot to stay compatible with.

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
 * the resulting observed state: `{ repo, entity, number, to }`, where `to` is
 * `delta.to.fingerprint` -- the compared-fields-only section of the item (see
 * lib/snapshot.mjs), never `context` or `meta`. Because the fingerprint
 * (including GitHub's `updatedAt` / `headRefOid`) is a property of the
 * observation and not of the observer's history, two monitors that see the same
 * current GitHub state emit the same id — cross-monitor idempotency.
 *
 * When `to` is null (the `missing` / `still-missing` / `presumed-deleted`
 * lifecycle) there is no observed state, so identity keys on the last-seen
 * `from.fingerprint` plus `classes` and `missingTicks` — the fields that
 * distinguish the three missing stages of the same object.
 *
 * `monitorId`, the report `at`, `title`, and any derived display fields are
 * deliberately excluded: the id addresses the observed change, not the observer.
 */
export function deltaIdentity(repo, delta) {
  const { entity, number } = delta;
  if (delta.to != null) {
    return {
      repo,
      entity,
      number,
      to: delta.to.fingerprint,
      ...(delta.staleAt ? { staleAt: delta.staleAt } : {}),
    };
  }
  return {
    repo,
    entity,
    number,
    from: delta.from?.fingerprint,
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
