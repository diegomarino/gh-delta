// Pure delta classifier. It compares old fingerprints to current GitHub objects
// and emits semantic classes without doing any I/O.
import { prFingerprint, issueFingerprint, stableValue } from './fingerprint.mjs';

const MISSING_DEMOTE_TICKS = 3;

// The `context` section of a snapshot item: identity/display fields, never
// compared and never hashed into the delta id (see lib/snapshot.mjs). Deltas
// carry this same object as their own top-level `context` (schema v2 --
// see lib/cli/detector.mjs), so it doubles as the delta's contextual metadata: PR
// deltas additionally carry the head branch name (symmetric with title);
// issues have no head branch. GitHub retains `headRefName` even after the
// branch is deleted, so it is effectively always present (`?? null` is
// defensive only).
function buildContext(kind, obj) {
  return {
    id: obj.id ?? null,
    title: obj.title ?? null,
    url: obj.url ?? null,
    author: obj.author ?? null,
    createdAt: obj.createdAt ?? null,
    ...(kind === 'pr' ? { headRefName: obj.headRefName ?? null } : {}),
  };
}

// A JSON.stringify inequality between two sorted string arrays.
function sortedListChanged(oldList, newList) {
  return JSON.stringify(oldList) !== JSON.stringify(newList);
}

// Diff two sorted `{id, resolved}` arrays for thread-identity set changes:
// ids newly unresolved (new thread, or an old one reopened) vs. ids newly
// resolved.
export function threadSetDiff(oldStates = [], newStates = []) {
  const oldResolved = new Map(oldStates.filter((t) => t?.id).map((t) => [t.id, t.resolved]));
  const addedIds = [];
  const removedIds = [];
  for (const t of newStates) {
    if (!t?.id) continue;
    const wasResolved = oldResolved.has(t.id) ? oldResolved.get(t.id) : null;
    if (!t.resolved && wasResolved !== false) addedIds.push(t.id); // newly unresolved
    if (t.resolved && wasResolved === false) removedIds.push(t.id); // newly resolved
  }
  addedIds.sort();
  removedIds.sort();
  return { addedIds, removedIds };
}

/**
 * For each thread present in both `oldThreads` and `newThreads` whose
 * `comments` count rose, return `{ id, increment }` sorted by id. A thread
 * with no prior state (first observed this tick) has no baseline to diff
 * replies against and is deliberately excluded, even if its own comment
 * count is already nonzero. Shared by `--enrich thread-replies`
 * (lib/enrich.mjs) and the pre-publish --ignore-authors filter pass for the
 * double opt-in (lib/cli/detector.mjs), so both agree on exactly which threads and
 * how many trailing replies to fetch.
 *
 * Known limitation, accepted deliberately (same "honest, not silent" spirit
 * as the reviewComments clamp in lib/gh.mjs): this is a NET increment.
 * Within one poll interval, if old replies on a thread are deleted while
 * new ones from different authors are added, `newCount - oldCount`
 * undercounts true additions and `comments(last: increment)` can miss some
 * of them. A consumer using this for --ignore-authors suppression can
 * therefore, in that narrow race, conclude "all new replies are ignored"
 * while an unaccounted human reply exists outside the fetched window. Not
 * fixed here (would require full pagination/id-set diffing, out of this
 * task's scope) -- documented so a future task can decide whether to close it.
 *
 * Each entry also carries `total`: the observed comment count on `newThreads`
 * at the moment this tick ran. `fetchThreadReplies` (lib/gh.mjs) compares
 * this against the *current* `comments.totalCount` it reads at fetch time and
 * fails the whole batch open (throws, never silently suppresses) if they
 * differ -- a reply landed or was removed between observation and
 * enrichment, so the `last: increment` window it would fetch no longer
 * corresponds to the window this increment was computed from.
 */
export function threadReplyIncrements(oldThreads = [], newThreads = []) {
  const oldById = new Map((oldThreads ?? []).filter((t) => t?.id).map((t) => [t.id, t]));
  const increments = [];
  for (const t of newThreads ?? []) {
    if (!t?.id) continue;
    const old = oldById.get(t.id);
    if (!old) continue;
    const increment = (t.comments ?? 0) - (old.comments ?? 0);
    if (increment > 0) increments.push({ id: t.id, increment, total: t.comments });
  }
  increments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return increments;
}

function threadCounts(fp) {
  const threads = Array.isArray(fp?.threads) ? fp.threads : [];
  return { total: threads.length, unresolved: threads.filter((t) => !t?.resolved).length };
}

function classifyPr(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'merged') c.push('merged');
    else if (fp.state === 'closed') c.push('closed');
    else if (fp.state === 'open') c.push('reopened');
  }
  if (oldFp.isDraft === true && fp.isDraft === false) c.push('draft-ready');
  if (oldFp.isDraft === false && fp.isDraft === true) c.push('converted-to-draft');
  if (oldFp.headSha !== fp.headSha) c.push('head-changed');
  if (JSON.stringify(oldFp.checks) !== JSON.stringify(fp.checks)) c.push('ci-changed');
  if (
    oldFp.reviewDecision !== fp.reviewDecision ||
    JSON.stringify(oldFp.reviews) !== JSON.stringify(fp.reviews)
  )
    c.push('review-changed');
  // Only a real mergeability resolution counts; unknown is a mid-recompute placeholder.
  if (fp.mergeable === 'mergeable' && oldFp.mergeable === 'conflicting') c.push('became-mergeable');
  if (fp.mergeable === 'conflicting' && oldFp.mergeable === 'mergeable')
    c.push('became-conflicting');
  if (fp.conversationComments > oldFp.conversationComments) c.push('new-comments');
  if (fp.conversationComments < oldFp.conversationComments) c.push('comments-removed');
  if (fp.reviewComments > oldFp.reviewComments) c.push('review-comments-added');
  if (fp.reviewComments < oldFp.reviewComments) c.push('review-comments-removed');
  if (oldFp.baseRef !== fp.baseRef) c.push('base-changed');
  if (sortedListChanged(oldFp.labels, fp.labels)) c.push('relabeled');
  if (sortedListChanged(oldFp.assignees, fp.assignees)) c.push('assignees-changed');
  if (sortedListChanged(oldFp.reviewRequests, fp.reviewRequests)) c.push('review-requests-changed');
  if (oldFp.state === 'open' && fp.state === 'open') {
    const oldCounts = threadCounts(oldFp);
    const newCounts = threadCounts(fp);
    // The counters alone go blind when one thread resolves and another
    // reopens in the same tick (totals unchanged). `threadSetDiff` recovers
    // that case by comparing thread identity, not just counts, and is the
    // reason a delta fires here even when neither counter moved.
    const { addedIds, removedIds } = threadSetDiff(oldFp.threads, fp.threads);
    const added = newCounts.unresolved > oldCounts.unresolved || addedIds.length > 0;
    const resolved = newCounts.unresolved < oldCounts.unresolved || removedIds.length > 0;
    if (added) c.push('unresolved-threads-added');
    if (resolved) c.push('unresolved-threads-resolved');
    if (!added && !resolved && newCounts.total !== oldCounts.total)
      c.push('review-threads-changed');
  }
  return c;
}

function classifyIssue(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'closed') c.push('closed');
    else if (fp.state === 'open') c.push('reopened');
  }
  if (JSON.stringify(oldFp.labels) !== JSON.stringify(fp.labels)) c.push('relabeled');
  if (sortedListChanged(oldFp.assignees, fp.assignees)) c.push('assignees-changed');
  if (fp.conversationComments > oldFp.conversationComments) c.push('new-comments');
  if (fp.conversationComments < oldFp.conversationComments) c.push('comments-removed');
  return c;
}

// Compare two `fingerprint` sections for equality. There is no drop-list: every
// field in `fingerprint` is compared-fields-only by construction (see
// prFingerprint/issueFingerprint), so a plain deep-equal is the whole story.
function fingerprintChanged(a, b) {
  return JSON.stringify(stableValue(a)) !== JSON.stringify(stableValue(b));
}

/**
 * Diff one entity family (pr or issue) against its previous fingerprint map.
 *
 * Runs in two passes over four cases:
 *  1. Fetched objects -- `new` or `first-seen` (no prior fp), `reappeared`
 *     (prior fp was `missing`, optionally plus a specific class if it also
 *     changed), or a normal change classified by `classifyFn` (falling back to
 *     `updated` for updatedAt/head-only churn).
 *  2. Prior keys absent from the fetch -- escalated through the missing
 *     lifecycle: `missing` (tick 1) -> `still-missing` -> `presumed-deleted`
 *     at `MISSING_DEMOTE_TICKS`, after which the key stays in memory but goes
 *     silent. Only items believed OPEN can go missing; a dormant closed item
 *     not re-fetched is expected under the incremental contract, not a delta.
 *
 * `nextMap` always carries every key forward (including silent missing ones) so
 * watcher memory survives across ticks and partial `--entities` runs.
 */
// Build the meta section for an item that was just fetched (present in the
// current tick), given the prior item (or null for a first-seen object) and
// whether its fingerprint changed this tick.
function nextMeta(oldItem, changed, at) {
  const oldMeta = oldItem?.meta;
  return {
    seenAt: at,
    changedAt: changed ? at : (oldMeta?.changedAt ?? at),
    ticksSinceChange: changed ? 0 : (oldMeta?.ticksSinceChange ?? -1) + 1,
    missingTicks: 0,
    // A real change clears any prior stale mark: the item is fresh again, so a
    // later relapse into staleness must be free to re-fire for a new date.
    staleEmittedFor: changed ? null : (oldMeta?.staleEmittedFor ?? null),
  };
}

function diffEntity(kind, oldMap, objects, fpFn, classifyFn, { at, staleAfterMs } = {}) {
  const deltas = [];
  const nextMap = { ...oldMap };
  const seen = new Set();
  const staleEnabled = Number.isFinite(staleAfterMs) && staleAfterMs > 0;
  const atMs = staleEnabled ? Date.parse(at) : NaN;
  if (staleEnabled && !Number.isFinite(atMs)) throw new Error('invalid stale clock timestamp');
  for (const obj of objects) {
    const key = String(obj.number);
    const fp = fpFn(obj);
    const context = buildContext(kind, obj);
    seen.add(key);
    const oldItem = oldMap[key];
    if (!oldItem) {
      const item = { fingerprint: fp, context, meta: nextMeta(null, true, at) };
      nextMap[key] = item;
      // A first-observed closed/merged object may predate the baseline; avoid
      // calling it newly created just because it first entered watcher memory.
      deltas.push({
        entity: kind,
        number: obj.number,
        context,
        classes: [fp.state === 'open' ? 'new' : 'first-seen'],
        // Delta-top-level, not context: a fact about this occurrence (derived
        // from classes), not identity/display of the item (see buildContext).
        // `baselineStateDeltas` below relabels these same deltas to
        // `baseline-state` and spreads this flag through unchanged.
        firstObserved: true,
        from: null,
        to: item,
      });
      continue;
    }
    const wasMissing = (oldItem.meta?.missingTicks ?? 0) > 0;
    if (wasMissing) {
      const changedAfterReturn = fingerprintChanged(oldItem.fingerprint, fp);
      let classes = ['reappeared'];
      if (changedAfterReturn) {
        const specific = classifyFn(oldItem.fingerprint, fp);
        classes = [...classes, ...(specific.length ? specific : ['updated'])];
      }
      const item = { fingerprint: fp, context, meta: nextMeta(oldItem, changedAfterReturn, at) };
      deltas.push({
        entity: kind,
        number: obj.number,
        context,
        classes,
        from: oldItem,
        to: item,
      });
      nextMap[key] = item;
      continue;
    }
    const changed = fingerprintChanged(oldItem.fingerprint, fp);
    if (!changed) {
      if (
        staleEnabled &&
        oldItem.meta?.changedAt != null &&
        !Number.isFinite(Date.parse(oldItem.meta.changedAt))
      )
        throw new Error(`invalid persisted changedAt for ${kind} #${key}`);
      const item = { fingerprint: fp, context, meta: nextMeta(oldItem, false, at) };
      if (
        staleEnabled &&
        fp.state === 'open' &&
        atMs - Date.parse(item.meta.changedAt) >= staleAfterMs
      ) {
        const staleAt = new Date(atMs).toISOString().slice(0, 10);
        if (oldItem.meta?.staleEmittedFor !== staleAt) {
          item.meta.staleEmittedFor = staleAt;
          deltas.push({
            entity: kind,
            number: obj.number,
            context,
            classes: ['stale'],
            staleAt,
            from: oldItem,
            to: item,
          });
        }
      }
      nextMap[key] = item;
      continue;
    }
    const item = { fingerprint: fp, context, meta: nextMeta(oldItem, true, at) };
    nextMap[key] = item;
    let classes = classifyFn(oldItem.fingerprint, fp);
    if (classes.length === 0) classes = ['updated']; // catch-all: updatedAt/head-only
    deltas.push({
      entity: kind,
      number: obj.number,
      context,
      classes,
      from: oldItem,
      to: item,
    });
  }
  for (const [key, oldItem] of Object.entries(oldMap)) {
    if (seen.has(key)) continue;
    const wasMissing = (oldItem.meta?.missingTicks ?? 0) > 0;
    // Incremental fetch contract: a closed item that simply was not updated is
    // dormant memory, not a missing object. Only open-believed items can vanish.
    if (!wasMissing && oldItem.fingerprint.state !== 'open') continue;
    const ticks = wasMissing ? (oldItem.meta.missingTicks ?? 1) + 1 : 1;
    nextMap[key] = { ...oldItem, meta: { ...oldItem.meta, missingTicks: ticks } };
    if (ticks > MISSING_DEMOTE_TICKS) continue; // archived: silent, memory intact
    const classes =
      ticks === 1
        ? ['missing']
        : ticks < MISSING_DEMOTE_TICKS
          ? ['still-missing']
          : ['presumed-deleted'];
    deltas.push({
      entity: kind,
      number: Number(key),
      // Last known context, title included: real display text from the
      // snapshot, not a placeholder string. It may be stale (we cannot
      // confirm it without a successful fetch), but a last-known title is
      // more useful to a consumer than a sentinel would be.
      context: oldItem.context,
      classes,
      missingTicks: ticks,
      from: oldItem,
      to: null,
    });
  }
  return { deltas, nextMap };
}

// Opt-in baseline emission (--baseline-emit-state). On a baseline run diffEntity
// already builds a `new` delta for every fetched item; they are normally
// discarded because a baseline seeds memory silently. Reuse exactly those,
// keeping only the OPEN ones, and relabel them to the informational
// `baseline-state` class so a consumer can react to trouble that already existed
// at seed time (a PR already conflicting or already blocked on CI). The delta id
// is unaffected: deltaIdentity hashes {repo, entity, number, to} when to != null,
// so re-seeding over unchanged state yields identical ids (idempotent dedupe).
// `firstObserved: true` (set on every source `new`/`first-seen` delta) survives
// the `{...d}` spread below unchanged, since baseline-state is itself one of
// the three first-observed classes.
function baselineStateDeltas(prDeltas, issueDeltas) {
  return [...prDeltas, ...issueDeltas]
    .filter((d) => d.to != null && d.to.fingerprint.state === 'open')
    .map((d) => ({ ...d, classes: ['baseline-state'] }));
}

/**
 * Compare a previous snapshot with the current GitHub fetch.
 *
 * Missing old snapshots seed a baseline with no deltas. Fetched collections are
 * authoritative only for their entity family; omitted families are preserved so
 * partial `--entities` runs do not erase watcher memory.
 *
 * `options.emitBaselineState` (default `false`) opts a baseline run into emitting
 * one synthetic `baseline-state` delta per tracked OPEN item instead of the usual
 * empty `deltas`; every non-baseline run and every baseline run without the flag is
 * byte-identical to before.
 *
 * @param {null|{pr?: Record<string, Record<string, unknown>>, issue?: Record<string, Record<string, unknown>>}} oldSnapshot
 * @param {{pr?: Array<Record<string, unknown>>, issue?: Array<Record<string, unknown>>}} current
 * @param {{emitBaselineState?: boolean}} [options]
 * @returns {{baseline: boolean, deltas: Array<Record<string, unknown>>, snapshot: {pr: Record<string, unknown>, issue: Record<string, unknown>}}}
 */
export function detectDeltas(
  oldSnapshot,
  current,
  { emitBaselineState = false, at, staleAfterMs } = {},
) {
  const baseline = oldSnapshot == null;
  const oldPr = oldSnapshot?.pr ?? {};
  const oldIssue = oldSnapshot?.issue ?? {};
  const prRes = Array.isArray(current.pr)
    ? diffEntity('pr', oldPr, current.pr, prFingerprint, classifyPr, { at, staleAfterMs })
    : { deltas: [], nextMap: oldPr };
  const issueRes = Array.isArray(current.issue)
    ? diffEntity('issue', oldIssue, current.issue, issueFingerprint, classifyIssue, {
        at,
        staleAfterMs,
      })
    : { deltas: [], nextMap: oldIssue };
  const snapshot = { pr: prRes.nextMap, issue: issueRes.nextMap };
  const deltas = baseline
    ? emitBaselineState
      ? baselineStateDeltas(prRes.deltas, issueRes.deltas)
      : []
    : [...prRes.deltas, ...issueRes.deltas];
  return { baseline, deltas, snapshot };
}
