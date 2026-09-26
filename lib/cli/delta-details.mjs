// Pure delta summaries and field-level transition details.
import { threadSetDiff } from '../detect.mjs';
import { diffFingerprint } from '../diff.mjs';
import { deltaSummary } from '../summary.mjs';

/**
 * Build a compact human-readable summary line for a single delta.
 */
function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.context?.title}": ${d.classes.join(', ')}`;
}

function hasField(value, field) {
  return value != null && Object.hasOwn(value, field);
}

// Snapshot items store `{ fingerprint, context, meta }` (see lib/snapshot.mjs);
// every detail-row helper below explains a *fingerprint* transition, so they
// all read through this accessor rather than the item itself.
function fpOf(item) {
  return item?.fingerprint;
}

function fieldDetail(klass, field, from, to, extra = {}) {
  return Object.fromEntries(
    Object.entries({ class: klass, field, from, to, ...extra }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function pushFieldDetail(details, klass, delta, field, extra = {}) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  if (!hasField(from, field) && !hasField(to, field)) return;
  const fromValue = hasField(from, field) ? from[field] : null;
  const toValue = hasField(to, field) ? to[field] : null;
  if (JSON.stringify(fromValue) === JSON.stringify(toValue)) return;
  details.push(fieldDetail(klass, field, fromValue, toValue, extra));
}

// `reviewThreads`/`unresolvedReviewThreads` are not stored fingerprint fields
// in schema v2 (R2 dropped the separate counters in favor of the single
// `threads[]` array); they are derived on demand from `threads[]`, the array
// that actually enters the delta id.
function derivedField(fp, field) {
  if (field === 'reviewThreads') return Array.isArray(fp?.threads) ? fp.threads.length : undefined;
  if (field === 'unresolvedReviewThreads')
    return Array.isArray(fp?.threads) ? fp.threads.filter((t) => !t?.resolved).length : undefined;
  return hasField(fp, field) ? fp[field] : undefined;
}

function pushNumericDelta(details, klass, delta, field) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  const fromValue = derivedField(from, field);
  const toValue = derivedField(to, field);
  if (fromValue === undefined || toValue === undefined) return;
  if (fromValue === toValue) return;
  const extra = { delta: toValue - fromValue };
  if (klass === 'new-comments') {
    const added = to?.recentComments;
    const conversationIncrement =
      (to?.conversationComments ?? NaN) - (from?.conversationComments ?? NaN);
    if (
      conversationIncrement === extra.delta &&
      Array.isArray(added) &&
      extra.delta > 0 &&
      extra.delta <= added.length
    ) {
      const rows = added.slice(-extra.delta);
      if (rows.every((row) => row?.id && row?.author)) extra.added = rows;
      else extra.opaque = true;
    } else extra.opaque = true;
  }
  details.push(fieldDetail(klass, field, fromValue, toValue, extra));
}

// Set-style detail for sorted string-list fingerprint fields (labels,
// assignees, reviewRequests): name what entered and what left.
function pushSetDelta(details, klass, delta, field) {
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);
  const from = hasField(fromFp, field) ? fromFp[field] : [];
  const to = hasField(toFp, field) ? toFp[field] : [];
  const oldEntries = new Set(from);
  const newEntries = new Set(to);
  details.push({
    class: klass,
    field,
    added: to.filter((entry) => !oldEntries.has(entry)),
    removed: from.filter((entry) => !newEntries.has(entry)),
  });
}

// Set-style detail naming the review-thread ids that newly became unresolved
// or resolved, for the `unresolved-threads-added`/`-resolved` classes. This is
// what lets `--detail` name a same-count swap (P2-1): the counters alone are
// unchanged in that case, so `pushNumericDelta` returns nothing, and this is
// the only detail row that names the affected threads. Omitted entirely when
// there is nothing to name (a class that fired purely from the counter moving
// with no identity-level swap).
function pushThreadSetDelta(details, klass, delta) {
  const { addedIds, removedIds } = threadSetDiff(
    fpOf(delta.from)?.threads,
    fpOf(delta.to)?.threads,
  );
  if (addedIds.length === 0 && removedIds.length === 0) return;
  details.push({ class: klass, field: 'threads', added: addedIds, removed: removedIds });
}

function changedFingerprintFields(delta) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  if (!from || !to) return [];
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...keys]
    .filter(
      (key) =>
        // checks/reviews/threads each already drive a dedicated class detail
        // (ci-changed's named breakdown, review-changed's named breakdown,
        // unresolved-threads-added/-resolved's threads row) whenever they are
        // the reason a delta fired, so `updated` (the catch-all for when
        // nothing else classified) never needs to duplicate them here.
        // recentComments is a bounded rolling window (see prFingerprint):
        // its contents can rotate (an old comment drops off, a new one
        // enters) with the comment count unchanged, which is not itself
        // actionable -- any real count change is already captured by
        // conversationComments/reviewComments, which ARE declared. Reporting
        // recentComments here would also require declaring it in
        // DELTA_DETAIL_FIELDS_BY_CLASS.updated; excluding it keeps that
        // catalog matching what `updated` can actually emit.
        !['checks', 'reviews', 'threads', 'recentComments'].includes(key),
    )
    .filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
    .sort();
}

// Diff two normalized summary arrays keyed by one field (check `name` or review
// `author`), yielding the added/removed entries and per-key from/to transitions.
// Returns null when either side repeats a key (e.g. a CheckRun and a
// StatusContext sharing one name): the maps would silently collapse the
// duplicates and misreport the breakdown, so the caller must fall back to opaque.
function diffSummaries(from, to, key) {
  const fromByKey = new Map(from.map((entry) => [entry[key], entry]));
  const toByKey = new Map(to.map((entry) => [entry[key], entry]));
  if (fromByKey.size !== from.length || toByKey.size !== to.length) return null;
  const changed = [];
  for (const [k, fromEntry] of fromByKey) {
    const toEntry = toByKey.get(k);
    if (!toEntry || JSON.stringify(fromEntry) === JSON.stringify(toEntry)) continue;
    const { [key]: _from, ...fromRest } = fromEntry;
    const { [key]: _to, ...toRest } = toEntry;
    changed.push({ [key]: k, from: fromRest, to: toRest });
  }
  return {
    added: to.filter((entry) => !fromByKey.has(entry[key])),
    removed: from.filter((entry) => !toByKey.has(entry[key])),
    changed,
  };
}

// Build the extra detail keys for a checks/reviews array transition. Names the
// exact entries that changed so an agent can act without re-querying GitHub.
// Falls back to marking the transition `opaque: true` when duplicate keys (a
// CheckRun and a StatusContext sharing one name) make the breakdown unsafe to
// report, or there is nothing to name.
function summaryDiffExtra(delta, field, key) {
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);
  const from = fromFp?.[field];
  const to = toFp?.[field];
  if (!Array.isArray(from) || !Array.isArray(to)) return { opaque: true };
  const diff = diffSummaries(from, to, key);
  if (!diff || (!diff.added.length && !diff.removed.length && !diff.changed.length)) {
    return { opaque: true };
  }
  return diff;
}

// Expand one delta class into the schema's field-level `details` entries: the
// concrete from/to changes (state, labels, checks, presence, ...) a consumer
// needs to act without re-diffing the raw fingerprints. Each class maps to
// the fields it can meaningfully explain; checks/reviews transitions carry a
// named added/removed/changed breakdown when both sides' raw fingerprint
// arrays are comparable, and are marked `opaque: true` when they cannot name
// the change.
function detailForClass(delta, klass) {
  const details = [];
  switch (klass) {
    case 'new':
    case 'first-seen':
    case 'baseline-state':
      details.push({ class: klass, field: 'presence', from: null, to: 'present' });
      pushFieldDetail(details, klass, delta, 'state');
      break;
    case 'missing':
    case 'still-missing':
    case 'presumed-deleted':
      details.push(
        fieldDetail(klass, 'presence', 'present', 'missing', {
          missingTicks:
            delta.missingTicks ??
            delta.from?.meta?.missingTicks ??
            (klass === 'missing' ? 1 : undefined),
        }),
      );
      break;
    case 'reappeared':
      details.push(
        fieldDetail(klass, 'presence', 'missing', 'present', {
          missingTicks: delta.from?.meta?.missingTicks,
        }),
      );
      break;
    case 'closed':
    case 'reopened':
    case 'merged':
      pushFieldDetail(details, klass, delta, 'state');
      break;
    case 'draft-ready':
    case 'converted-to-draft':
      pushFieldDetail(details, klass, delta, 'isDraft');
      break;
    case 'ci-changed':
      pushFieldDetail(details, klass, delta, 'checks', summaryDiffExtra(delta, 'checks', 'name'));
      break;
    case 'review-changed':
      pushFieldDetail(details, klass, delta, 'reviewDecision');
      pushFieldDetail(details, klass, delta, 'reviews', summaryDiffExtra(delta, 'reviews', 'id'));
      break;
    case 'became-mergeable':
    case 'became-conflicting':
      pushFieldDetail(details, klass, delta, 'mergeable');
      break;
    case 'base-changed':
      pushFieldDetail(details, klass, delta, 'baseRef');
      break;
    case 'head-changed':
      pushFieldDetail(details, klass, delta, 'headSha');
      break;
    case 'stale':
      details.push({ class: klass, field: 'staleAt', from: null, to: delta.staleAt });
      break;
    case 'new-comments':
    case 'comments-removed':
      pushNumericDelta(details, klass, delta, 'conversationComments');
      break;
    case 'review-comments-added':
    case 'review-comments-removed':
      pushNumericDelta(details, klass, delta, 'reviewComments');
      break;
    case 'unresolved-threads-added':
    case 'unresolved-threads-resolved':
      pushNumericDelta(details, klass, delta, 'unresolvedReviewThreads');
      pushThreadSetDelta(details, klass, delta);
      break;
    case 'review-threads-changed':
      pushNumericDelta(details, klass, delta, 'reviewThreads');
      break;
    case 'relabeled':
      pushSetDelta(details, klass, delta, 'labels');
      break;
    case 'assignees-changed':
      pushSetDelta(details, klass, delta, 'assignees');
      break;
    case 'review-requests-changed':
      pushSetDelta(details, klass, delta, 'reviewRequests');
      break;
    case 'updated':
      for (const field of changedFingerprintFields(delta)) {
        const extra =
          field === 'checks'
            ? summaryDiffExtra(delta, 'checks', 'name')
            : field === 'reviews'
              ? summaryDiffExtra(delta, 'reviews', 'id')
              : {};
        pushFieldDetail(details, klass, delta, field, extra);
      }
      break;
    default:
      details.push({ class: klass, field: 'unknown', note: 'unrecognized class' });
      break;
  }
  return details;
}

function detailDelta(delta) {
  return delta.classes.flatMap((klass) => detailForClass(delta, klass));
}

// Exported so docs tooling (tools/examples) can render fixture deltas through
// the exact same enrichment the CLI uses, keeping example artifacts faithful.
function enrichDelta(delta, { summaryLine = false, details = false } = {}) {
  if (summaryLine) delta.summaryLine = line(delta);
  if (details) delta.details = detailDelta(delta);
  // `changed`/`summary` are always-on schema v2 fields (siblings of `to`,
  // never nested inside it, so the content-addressed delta.id -- which hashes
  // `to` -- stays unaffected). `summary` is null for the missing lifecycle
  // (no observed `to` state); every other delta gets one, PR or issue.
  delta.changed = diffFingerprint(delta.from?.fingerprint, delta.to?.fingerprint);
  delta.summary = deltaSummary(delta);
}

export { fpOf, enrichDelta };
