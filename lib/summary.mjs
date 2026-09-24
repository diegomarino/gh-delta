// Optional semantic summary layer. Derives typed, normalized facts (is CI green?
// what did reviewers decide? is it mergeable?) from the SAME `to` fingerprint the
// checks/reviews/threads rows live in -- no second GitHub fetch. The fingerprint
// stays the authoritative change-detection artifact; this layer is a read-only
// hint a consumer can trust or re-derive. Honesty over richness: an un-observed
// or not-yet-computed value is reported as an explicit `none`/`unknown`, never
// faked.
//
// Every enum on the fingerprint is already lowercased at the lib/gh.mjs fetch
// boundary (see `lower()` there), so this layer does no case mapping of its
// own -- it reads and derives, it does not normalize.

// GitHub check/status tokens partitioned into a fail-closed rollup. A row is
// classified by inspecting BOTH its `status` and `conclusion`, which lets one
// table cover CheckRun rows (status/conclusion independent) and StatusContext
// rows (where lib/gh.mjs sets status === conclusion === the lowercased
// StatusState) without needing the original __typename.
const CI_FAILED_TOKENS = new Set([
  'failure',
  'error',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);
const CI_PENDING_TOKENS = new Set([
  'queued',
  'in_progress',
  'waiting',
  'pending',
  'requested',
  'expected',
]);
// success / neutral / skipped / completed are the non-blocking remainder: they
// contribute 'green' and are never listed explicitly.

/**
 * Roll a normalized CI check list up to a single typed verdict.
 *
 * Input is `to.checks` -- the sorted `{name, kind, status, conclusion}` rows
 * that are themselves the compared fingerprint field (see lib/fingerprint.mjs).
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
 * @param {Array<{name?: string, status?: string, conclusion?: string}>} [checks]
 * @returns {'green' | 'failed' | 'pending' | 'none'}
 */
export function deriveCiRollup(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  if (rows.length === 0) return 'none';
  let pending = false;
  for (const row of rows) {
    const status = row?.status ?? '';
    const conclusion = row?.conclusion ?? '';
    if (CI_FAILED_TOKENS.has(status) || CI_FAILED_TOKENS.has(conclusion)) return 'failed';
    if (CI_PENDING_TOKENS.has(status) || CI_PENDING_TOKENS.has(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

/**
 * Extract the failed subset of `to.checks` as `{name, runId, jobId, detailsUrl}`
 * rows, so a merge gate can read the exact failing checks without walking
 * `to.checks` itself. Reuses the same fail-closed token test as
 * `deriveCiRollup` (a row is failed if EITHER its status or its conclusion is
 * a failing token). Input is already sorted by `buildChecks` (see
 * lib/fingerprint.mjs), so filtering preserves a deterministic order.
 *
 * `runId`/`jobId` are omitted (not carried as `null`) on a row whose
 * `detailsUrl` did not parse into an Actions run/job URL, matching
 * `buildChecks`'s omit-vs-null representation.
 */
function failedChecksFrom(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  return rows
    .filter((row) => {
      const status = row?.status ?? '';
      const conclusion = row?.conclusion ?? '';
      return CI_FAILED_TOKENS.has(status) || CI_FAILED_TOKENS.has(conclusion);
    })
    .map((row) => ({
      name: row?.name ?? '',
      ...(row?.runId !== undefined ? { runId: row.runId } : {}),
      ...(row?.jobId !== undefined ? { jobId: row.jobId } : {}),
      detailsUrl: row?.detailsUrl ?? null,
    }));
}

/**
 * Build the normalized semantic summary for one observed PR `to` fingerprint.
 *
 * Every field is a pure function of `to` -- no I/O, no second fetch -- so the
 * summary reflects the exact observation that produced the fingerprint. Returns
 * null when there is no observed state (the missing/presumed-deleted lifecycle).
 *
 * @param {Record<string, unknown>|null|undefined} to
 * @returns {null | {
 *   ciRollup: 'green'|'failed'|'pending'|'none',
 *   reviewDecision: 'approved'|'changes_requested'|'review_required'|'none',
 *   mergeable: 'mergeable'|'conflicting'|'unknown',
 *   mergeStateStatus: 'behind'|'blocked'|'clean'|'dirty'|'draft'|'has_hooks'|'unstable'|'unknown',
 *   state: 'open'|'closed'|'merged'|string,
 *   isDraft: boolean,
 *   unresolvedReviewThreads: number,
 *   headSha: string,
 *   failedChecks: Array<{name: string, runId?: string, jobId?: string, detailsUrl: string|null}>,
 * }}
 */
export function prSummary(to) {
  if (to == null) return null;
  return {
    ciRollup: deriveCiRollup(to.checks),
    reviewDecision: to.reviewDecision || 'none',
    mergeable: to.mergeable || 'unknown',
    mergeStateStatus: to.mergeStateStatus || 'unknown',
    state: typeof to.state === 'string' ? to.state : '',
    isDraft: to.isDraft === true,
    unresolvedReviewThreads: Array.isArray(to.threads)
      ? to.threads.filter((t) => t?.resolved !== true).length
      : 0,
    headSha: typeof to.headSha === 'string' ? to.headSha : '',
    failedChecks: failedChecksFrom(to.checks),
  };
}

/**
 * Build the normalized semantic summary for one observed issue `to` fingerprint.
 *
 * Issues carry none of a PR's CI/review/mergeability facts, so this is
 * deliberately minimal: just the observed state. Returns null when there is
 * no observed state (the missing/presumed-deleted lifecycle).
 *
 * @param {Record<string, unknown>|null|undefined} to
 * @returns {null | { state: 'open'|'closed'|string }}
 */
export function issueSummary(to) {
  if (to == null) return null;
  return { state: typeof to.state === 'string' ? to.state : '' };
}

/**
 * Return the semantic summary for a delta, or null when there is no observed
 * `to` state to summarize.
 *
 * Every delta with a current object (`to != null`) gets a summary regardless
 * of which class fired -- a fail-closed gate wants the current observed
 * state, not just what changed. PR deltas get the full `prSummary`; issue
 * deltas get the minimal `issueSummary`. The missing lifecycle (no `to`) gets
 * null -- there is no current observation to summarize. `to` is a snapshot
 * item (`{ fingerprint, context, meta }`); only `fingerprint` -- the compared
 * fields -- feeds the summary.
 *
 * @param {Record<string, unknown>|null|undefined} delta
 * @returns {ReturnType<typeof prSummary> | ReturnType<typeof issueSummary>}
 */
export function deltaSummary(delta) {
  if (!delta || delta.to == null) return null;
  if (delta.entity === 'pr') return prSummary(delta.to.fingerprint);
  if (delta.entity === 'issue') return issueSummary(delta.to.fingerprint);
  return null;
}
