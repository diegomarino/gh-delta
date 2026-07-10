// Optional semantic summary layer. Derives typed, normalized facts (is CI green?
// what did reviewers decide? is it mergeable?) from the SAME `to` fingerprint the
// opaque digests were hashed from -- no second GitHub fetch. The fingerprints stay
// the authoritative change-detection artifact; this layer is a read-only hint a
// consumer can trust or re-derive. Honesty over richness: an un-observed or
// not-yet-computed value is reported as an explicit `none`/`unknown`, never faked.

// GitHub check/status tokens partitioned into a fail-closed rollup. A row is
// classified by inspecting BOTH its `status` and `conclusion`, which lets one
// table cover CheckRun rows (status in CheckStatusState, conclusion in
// CheckConclusionState or '' while running) and StatusContext rows (where
// summarizeCiRollup sets status === conclusion === the StatusState) without
// needing the original __typename.
const CI_FAILED_TOKENS = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const CI_PENDING_TOKENS = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'PENDING',
  'REQUESTED',
  'EXPECTED',
]);
// SUCCESS / NEUTRAL / SKIPPED / COMPLETED are the non-blocking remainder: they
// contribute 'green' and are never listed explicitly.

const REVIEW_DECISIONS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

const MERGEABLE_STATES = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
};

const PR_STATES = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
};

const upper = (value) => String(value ?? '').toUpperCase();

/**
 * Roll a normalized CI check list up to a single typed verdict.
 *
 * Input is `to.ciChecks` -- the sorted `{name, status, conclusion}` rows produced
 * by summarizeCiRollup, the exact data the opaque `ci` digest was hashed from.
 *
 * CRITICAL: an empty list is `'none'`, never `'green'`. GitHub's own
 * statusCheckRollup.state reports SUCCESS-like values for a PR with zero checks;
 * collapsing that to `'green'` would let a fail-closed merge gate wave through a
 * PR that never ran CI. `'none'` hands that policy decision back to the consumer.
 *
 * Precedence is fail-closed: any failing check wins, else any pending check, else
 * green. A row counts as failed/pending if EITHER its status or its conclusion is
 * a failing/pending token (see the token tables above).
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string}>} [ciChecks]
 * @returns {'green' | 'failed' | 'pending' | 'none'}
 */
export function deriveCiRollup(ciChecks) {
  const rows = Array.isArray(ciChecks) ? ciChecks : [];
  if (rows.length === 0) return 'none';
  let pending = false;
  for (const row of rows) {
    const tokens = [upper(row?.status), upper(row?.conclusion)];
    if (tokens.some((token) => CI_FAILED_TOKENS.has(token))) return 'failed';
    if (tokens.some((token) => CI_PENDING_TOKENS.has(token))) pending = true;
  }
  return pending ? 'pending' : 'green';
}

/**
 * Normalize GitHub's `reviewDecision` to a lowercase enum.
 *
 * GraphQL emits APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED or null. The null
 * case maps to `'none'`. Note: GitHub returns null for two distinct reasons the
 * fingerprint cannot tell apart without a branch-protection fetch we deliberately
 * skip -- "no review-required rule on this branch" and "review required but none
 * submitted yet" -- so `'none'` means "no decision observed", not "not required".
 *
 * @param {string|null|undefined} review - raw `to.review`
 * @returns {'approved' | 'changes_requested' | 'review_required' | 'none'}
 */
export function normalizeReviewDecision(review) {
  return REVIEW_DECISIONS[upper(review)] ?? 'none';
}

/**
 * Normalize GitHub's tri-state `mergeable` to a lowercase enum.
 *
 * MERGEABLE and CONFLICTING map directly; anything else (UNKNOWN, or absent)
 * becomes `'unknown'`. UNKNOWN is GitHub still recomputing mergeability (common
 * right after a base-branch change), which is why this stays an enum rather than a
 * boolean: a fail-closed consumer must be able to tell `'conflicting'` from
 * "not computed yet" and decide for itself.
 *
 * @param {string|null|undefined} mergeable - raw `to.mergeable`
 * @returns {'mergeable' | 'conflicting' | 'unknown'}
 */
export function normalizeMergeable(mergeable) {
  return MERGEABLE_STATES[upper(mergeable)] ?? 'unknown';
}

/**
 * Normalize a PR's GraphQL state (OPEN | CLOSED | MERGED) to lowercase.
 *
 * An unexpected value is lowercased rather than dropped so the field never
 * silently disappears; the three documented values are the only ones GitHub emits
 * for a pull request.
 *
 * @param {string|null|undefined} state - raw `to.state`
 * @returns {'open' | 'closed' | 'merged' | string}
 */
export function normalizePrState(state) {
  return PR_STATES[upper(state)] ?? String(state ?? '').toLowerCase();
}

/**
 * Build the normalized semantic summary for one observed PR `to` fingerprint.
 *
 * Every field is a pure function of `to` -- no I/O, no second fetch -- so the
 * summary reflects the exact observation that produced the fingerprints. Returns
 * null when there is no observed state (the missing/presumed-deleted lifecycle).
 *
 * @param {Record<string, unknown>|null|undefined} to
 * @returns {null | {
 *   ciRollup: 'green'|'failed'|'pending'|'none',
 *   reviewDecision: 'approved'|'changes_requested'|'review_required'|'none',
 *   mergeable: 'mergeable'|'conflicting'|'unknown',
 *   state: 'open'|'closed'|'merged'|string,
 *   isDraft: boolean,
 *   unresolvedReviewThreads: number,
 *   headSha: string,
 * }}
 */
export function prSummary(to) {
  if (to == null) return null;
  return {
    ciRollup: deriveCiRollup(to.ciChecks),
    reviewDecision: normalizeReviewDecision(to.review),
    mergeable: normalizeMergeable(to.mergeable),
    state: normalizePrState(to.state),
    isDraft: to.isDraft === true,
    unresolvedReviewThreads: Number.isInteger(to.unresolvedReviewThreads)
      ? to.unresolvedReviewThreads
      : 0,
    headSha: typeof to.head === 'string' ? to.head : '',
  };
}

/**
 * Return the semantic summary for a delta, or null when one does not apply.
 *
 * PR deltas with a current object (`to != null`) get a summary regardless of which
 * class fired -- a fail-closed gate wants the current observed state, not just what
 * changed. Issue deltas (no CI/review/mergeability) and the missing lifecycle
 * (no `to`) get null.
 *
 * @param {Record<string, unknown>|null|undefined} delta
 * @returns {ReturnType<typeof prSummary>}
 */
export function deltaSummary(delta) {
  if (!delta || delta.entity !== 'pr' || delta.to == null) return null;
  return prSummary(delta.to);
}
