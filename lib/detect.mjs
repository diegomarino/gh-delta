// Pure delta classifier. It compares old fingerprints to current GitHub objects
// and emits semantic classes without doing any I/O.
import {
  prFingerprint,
  issueFingerprint,
  comparableFingerprint,
  stableValue,
  ADDITIVE_COMPARED_FIELDS,
} from './fingerprint.mjs';

const MISSING_DEMOTE_TICKS = 3;

// Contextual, non-fingerprinted metadata attached to a delta when a current
// object exists. PR deltas carry the head branch name (symmetric with title);
// issues have no head branch. GitHub retains `headRefName` even after the branch
// is deleted, so it is effectively always present (`?? null` is defensive only).
// The missing/presumed-deleted branch has no current object, so it never calls this.
function currentObjectMeta(kind, obj) {
  return kind === 'pr' ? { headRefName: obj.headRefName ?? null } : {};
}

// A JSON.stringify inequality between two sorted string arrays. Guarded on the
// OLD side being an array: a snapshot written before the field existed must not
// classify the field's first appearance as a change (the additive-field upgrade
// case; fingerprintChanged applies the same suppression to the whole delta).
function sortedListChanged(oldList, newList) {
  return Array.isArray(oldList) && JSON.stringify(oldList) !== JSON.stringify(newList);
}

function classifyPr(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'MERGED') c.push('merged');
    else if (fp.state === 'CLOSED') c.push('closed');
    else if (fp.state === 'OPEN') c.push('reopened');
  }
  if (oldFp.isDraft === true && fp.isDraft === false) c.push('draft-ready');
  if (oldFp.isDraft === false && fp.isDraft === true) c.push('converted-to-draft');
  if (oldFp.ci !== fp.ci) c.push('ci-changed');
  if (oldFp.review !== fp.review || oldFp.reviews !== fp.reviews) c.push('review-changed');
  // Only a real mergeability resolution counts; UNKNOWN is a mid-recompute placeholder.
  if (fp.mergeable === 'MERGEABLE' && oldFp.mergeable === 'CONFLICTING') c.push('became-mergeable');
  if (fp.mergeable === 'CONFLICTING' && oldFp.mergeable === 'MERGEABLE')
    c.push('became-conflicting');
  if (fp.comments > oldFp.comments) c.push('new-comments');
  if (fp.comments < oldFp.comments) c.push('comments-removed');
  // Old-side typeof/Array guards: snapshots predating these compared fields must
  // not read the field's first appearance as a transition.
  if (typeof oldFp.base === 'string' && oldFp.base !== fp.base) c.push('base-changed');
  if (sortedListChanged(oldFp.labels, fp.labels)) c.push('relabeled');
  if (sortedListChanged(oldFp.assignees, fp.assignees)) c.push('assignees-changed');
  if (sortedListChanged(oldFp.reviewRequests, fp.reviewRequests)) c.push('review-requests-changed');
  if (oldFp.state === 'OPEN' && fp.state === 'OPEN') {
    const oldUnresolved = oldFp.unresolvedReviewThreads ?? 0;
    const newUnresolved = fp.unresolvedReviewThreads ?? 0;
    const oldThreads = oldFp.reviewThreads ?? 0;
    const newThreads = fp.reviewThreads ?? 0;
    if (newUnresolved > oldUnresolved) c.push('unresolved-threads-added');
    else if (newUnresolved < oldUnresolved) c.push('unresolved-threads-resolved');
    else if (newThreads !== oldThreads) c.push('review-threads-changed');
  }
  return c;
}

function classifyIssue(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'CLOSED') c.push('closed');
    else if (fp.state === 'OPEN') c.push('reopened');
  }
  if (JSON.stringify(oldFp.labels) !== JSON.stringify(fp.labels)) c.push('relabeled');
  if (sortedListChanged(oldFp.assignees, fp.assignees)) c.push('assignees-changed');
  if (fp.comments > oldFp.comments) c.push('new-comments');
  if (fp.comments < oldFp.comments) c.push('comments-removed');
  return c;
}

function fingerprintChanged(a, b) {
  const ca = comparableFingerprint(a);
  let cb = comparableFingerprint(b);
  // Additive-field upgrade: when the prior side (a) predates a compared field,
  // ignore it on the current side (b) too. This suppresses a one-time fleet-wide
  // `updated` burst on the first tick after upgrade while still catching every
  // genuine transition once both sides carry the field. (`b` always has each
  // field — the fingerprint builders default absent input to ''/[]/UNKNOWN.)
  if (ca && cb) {
    for (const field of ADDITIVE_COMPARED_FIELDS) {
      if (!(field in ca) && field in cb) {
        const { [field]: _ignored, ...rest } = cb;
        cb = rest;
      }
    }
  }
  return JSON.stringify(stableValue(ca)) !== JSON.stringify(stableValue(cb));
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
function diffEntity(kind, oldMap, objects, fpFn, classifyFn) {
  const deltas = [];
  const nextMap = { ...oldMap };
  const seen = new Set();
  for (const obj of objects) {
    const key = String(obj.number);
    const fp = fpFn(obj);
    seen.add(key);
    nextMap[key] = fp;
    const oldFp = oldMap[key];
    if (!oldFp) {
      // A first-observed closed/merged object may predate the baseline; avoid
      // calling it newly created just because it first entered watcher memory.
      deltas.push({
        entity: kind,
        number: obj.number,
        title: obj.title,
        ...currentObjectMeta(kind, obj),
        classes: [fp.state === 'OPEN' ? 'new' : 'first-seen'],
        from: null,
        to: fp,
      });
      continue;
    }
    const wasMissing = oldFp.missing === true;
    if (wasMissing) {
      const changedAfterReturn = fingerprintChanged(oldFp, fp);
      let classes = ['reappeared'];
      if (changedAfterReturn) {
        const specific = classifyFn(comparableFingerprint(oldFp), fp);
        classes = [...classes, ...(specific.length ? specific : ['updated'])];
      }
      deltas.push({
        entity: kind,
        number: obj.number,
        title: obj.title,
        ...currentObjectMeta(kind, obj),
        classes,
        from: oldFp,
        to: fp,
      });
      continue;
    }
    if (!fingerprintChanged(oldFp, fp)) continue;
    let classes = classifyFn(oldFp, fp);
    if (classes.length === 0) classes = ['updated']; // catch-all: updatedAt/head-only
    deltas.push({
      entity: kind,
      number: obj.number,
      title: obj.title,
      ...currentObjectMeta(kind, obj),
      classes,
      from: oldFp,
      to: fp,
    });
  }
  for (const [key, oldFp] of Object.entries(oldMap)) {
    if (seen.has(key)) continue;
    const wasMissing = oldFp.missing === true;
    // Incremental fetch contract: a closed item that simply was not updated is
    // dormant memory, not a missing object. Only open-believed items can vanish.
    if (!wasMissing && oldFp.state !== 'OPEN') continue;
    const ticks = wasMissing ? (oldFp.missingTicks ?? 1) + 1 : 1;
    nextMap[key] = { ...oldFp, missing: true, missingTicks: ticks };
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
      title: '(missing from current fetch)',
      classes,
      missingTicks: ticks,
      from: oldFp,
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
function baselineStateDeltas(prDeltas, issueDeltas) {
  return [...prDeltas, ...issueDeltas]
    .filter((d) => d.to != null && d.to.state === 'OPEN')
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
export function detectDeltas(oldSnapshot, current, { emitBaselineState = false } = {}) {
  const baseline = oldSnapshot == null;
  const oldPr = oldSnapshot?.pr ?? {};
  const oldIssue = oldSnapshot?.issue ?? {};
  const prRes = Array.isArray(current.pr)
    ? diffEntity('pr', oldPr, current.pr, prFingerprint, classifyPr)
    : { deltas: [], nextMap: oldPr };
  const issueRes = Array.isArray(current.issue)
    ? diffEntity('issue', oldIssue, current.issue, issueFingerprint, classifyIssue)
    : { deltas: [], nextMap: oldIssue };
  const snapshot = { pr: prRes.nextMap, issue: issueRes.nextMap };
  const deltas = baseline
    ? emitBaselineState
      ? baselineStateDeltas(prRes.deltas, issueRes.deltas)
      : []
    : [...prRes.deltas, ...issueRes.deltas];
  return { baseline, deltas, snapshot };
}
