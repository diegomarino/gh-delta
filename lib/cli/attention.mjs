// Pure attention filters and watched terminal-transition decisions.
import { fpOf } from './delta-details.mjs';

// Would the CURRENT invocation's --ignore-classes/--only-classes suppress
// `terminalClass` if it appeared on a delta right now? This is the one
// question with a stable, replay-independent answer -- unlike
// --ignore-authors/--settled, which depend on the actual delta content each
// tick and so cannot be "still active" in the same reusable sense (see
// isTerminalCleanupEligible's doc comment for the resulting, deliberately
// narrower scope of what this can protect).
function terminalClassFilteredByFlags(terminalClass, { onlyClasses, ignoreClasses }) {
  return (
    ignoreClasses.includes(terminalClass) ||
    (onlyClasses.length > 0 && !onlyClasses.includes(terminalClass))
  );
}

/**
 * Decide whether a delta may trigger `--until` watch-directory cleanup this
 * tick. Marking a watch entry as having had a terminal transition ignored
 * is a SEPARATE concern, handled entirely by
 * watchedTerminalTransitionSuppressed below. Seven rounds on this
 * predicate; the corrected three-way distinction:
 *
 *   1. First observation (`delta.from` is null: the `new`/`first-seen`/
 *      `baseline-state` classes -- see lib/detect.mjs's diffEntity, which
 *      never combines any of them with `merged`/`closed`). Always eligible
 *      -- there is no transition tick here for any filter to have meant
 *      "ignore this" about; the item was simply already terminal (or not)
 *      the very first time we ever saw it.
 *   2. A genuine transition this tick (`delta.from.state !== delta.to.state`
 *      -- exactly classifyPr/classifyIssue's own `if (oldFp.state !==
 *      fp.state)` guard, the ONLY condition under which they attach a
 *      `merged`/`closed` class at all). Eligibility is exactly "did that
 *      class survive filtering." Round 6 wrongly narrowed this to "from
 *      was OPEN": classifyPr classifies by DESTINATION state only, so a PR
 *      observed `closed`, then reopened and merged between polls, still
 *      emits `merged` even though `from.state` was already terminal
 *      (`closed`) -- a real transition round 6's `TERMINAL_STATES.has
 *      (priorState)` shortcut silently treated as "no transition happened",
 *      skipping the marker entirely. `from.state !== to.state` is the one
 *      test that actually matches what the classifier does.
 *   3. No transition this tick (`delta.from.state === delta.to.state`,
 *      both terminal, since `to.state` being terminal is already
 *      established above). Two sub-outcomes: with no recorded mark, always
 *      eligible -- this is the broad-poll case, where the item was
 *      terminal before it was ever watched (or its one transition was
 *      never actually filtered), so there is nothing here for any filter
 *      to have meant "ignore" about. WITH a recorded mark, eligible only
 *      once the CURRENT invocation's filters no longer target the recorded
 *      terminal class -- "removable as soon as the operator stops ignoring
 *      it" is the deliberate semantic (see lib/watch.mjs's
 *      markTerminalIgnored doc comment).
 */
function isTerminalCleanupEligible(delta, watchedEntry, filters) {
  const state = delta.to?.state;
  const terminalClass = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : null;
  if (terminalClass === null) return false;
  const priorState = delta.from?.state ?? null;
  if (priorState === null) return true;
  if (priorState !== state) return delta.classes.includes(terminalClass);
  if (watchedEntry?.ignoredTerminalAt === undefined) return true;
  return !terminalClassFilteredByFlags(terminalClass, filters);
}

// Detects case 2 above -- a genuine transition into a terminal state --
// whose matching class did NOT survive to the corresponding post-filter
// delta (`survivor`, looked up by the caller from applyAttentionFilters'
// OWN return value, or `undefined` if the whole delta was dropped). This
// must be checked against what filtering ACTUALLY did, never re-derived
// from the onlyClasses/ignoreClasses flag values: --only-classes is a
// DELTA-level gate (a delta with `classes: ['merged', 'relabeled']`
// survives WHOLE under `--only-classes relabeled`, `merged` included),
// while --ignore-classes is a CLASS-level removal. An earlier version of
// this function re-implemented that distinction from the flags alone and
// got it wrong: it treated `merged` as suppressed whenever `--only-classes`
// was active and did not itself name `merged`, even when the delta
// actually survived WITH `merged` intact because some other class matched.
// That wrote a spurious marker, and the marked-but-eligible delta then hit
// the cleanup loop below with `removeWatchedFile` comparing against the
// PRE-marker bytes this same tick's own write had already made stale,
// silently failing forever after (see the caller for why that specific
// failure mode cannot recur now that this function only reports a REAL
// suppression).
//
// Must run against the shape BEFORE the from/to fingerprint-stripping step
// later in run() (`delta.from`/`delta.to` are still `{fingerprint, context,
// meta}` here, hence `fpOf`).
//
// "Genuine transition this tick" is `priorState !== state` -- matching
// classifyPr/classifyIssue's own `if (oldFp.state !== fp.state)` guard,
// the only condition under which they ever attach a `merged`/`closed`
// class. An earlier version tested "was priorState ITSELF non-terminal"
// instead, which wrongly skipped a PR observed `closed`, then reopened and
// merged between polls: classifyPr classifies by destination state alone,
// so `closed -> merged` still emits `merged` even though `from.state` was
// already terminal. That silently skipped the marker for exactly the
// transition this function exists to catch.
function watchedTerminalTransitionSuppressed(delta, watched, survivor) {
  if (!watched || watched.entry.ignoredTerminalAt !== undefined) return false;
  const priorState = fpOf(delta.from)?.state ?? null;
  const state = fpOf(delta.to)?.state;
  const terminalClass = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : null;
  if (terminalClass === null) return false;
  if (priorState === null || priorState === state) return false;
  return !(survivor?.classes?.includes(terminalClass) ?? false);
}

// Attention filters are deliberately applied after detection. They may change
// the emitted report, but never the complete observation used for the snapshot.
function applyAttentionFilters(deltas, { onlyClasses, ignoreClasses, settled }) {
  const only = new Set(onlyClasses);
  const ignored = new Set(ignoreClasses);
  const survivors = [];
  let filteredDeltas = 0;

  for (const delta of deltas) {
    if (only.size > 0 && !delta.classes.some((klass) => only.has(klass))) {
      filteredDeltas++;
      continue;
    }
    const classes = delta.classes.filter((klass) => !ignored.has(klass));
    if (classes.length === 0) {
      filteredDeltas++;
      continue;
    }
    const filtered = classes.length === delta.classes.length ? delta : { ...delta, classes };
    if (
      settled &&
      (filtered.summary?.ciRollup === 'pending' || filtered.summary?.mergeable === 'unknown')
    ) {
      filteredDeltas++;
      continue;
    }
    survivors.push(filtered);
  }
  return { deltas: survivors, filteredDeltas };
}

// Attribute the reviews that changed between `from` and `to` (added ids, or
// an id whose row differs) -- the set --ignore-authors checks for
// review-changed. Returns [] when nothing is attributable (e.g. reviewDecision
// moved with no reviews[] row diff), which the caller treats as "cannot
// verify, fail open."
function changedOrNewReviews(fromFp, toFp) {
  if (!Array.isArray(toFp?.reviews)) return [];
  const oldById = new Map(
    (Array.isArray(fromFp?.reviews) ? fromFp.reviews : [])
      .filter((row) => row?.id)
      .map((row) => [row.id, JSON.stringify(row)]),
  );
  return toFp.reviews.filter((row) => row?.id && oldById.get(row.id) !== JSON.stringify(row));
}

// classifyPr fires review-changed on EITHER a reviewDecision move OR a
// reviews[] row diff (lib/detect.mjs). changedOrNewReviews above only ever
// names the row-level diff. If reviewDecision itself moved -- e.g. an admin
// dismissal or a branch-protection recompute with no reviews[] row change,
// or a tick where reviewDecision moved AND an unrelated ignored-author row
// also changed -- attributing the whole class to just the changed rows'
// authors would risk suppressing a reviewDecision transition a human needs
// to see for a reason the changed rows don't actually explain. Fail open
// (never suppress review-changed) whenever reviewDecision itself moved;
// only attempt suppression when reviewDecision is unchanged and every
// review row that differs belongs to an ignored author.
function reviewDecisionMoved(fromFp, toFp) {
  return (fromFp?.reviewDecision ?? 'none') !== (toFp?.reviewDecision ?? 'none');
}

function allAuthorsIgnored(authors, ignoredAuthors) {
  return (
    authors.length > 0 &&
    authors.every(
      (author) => typeof author === 'string' && ignoredAuthors.includes(author.toLowerCase()),
    )
  );
}

// Rewrite of the pre-schema-v2 commentAuthorsIgnored: that function made no
// network call, inspected only the last-5 conversation comment nodes, and
// handled only the new-comments class against the now-deleted aggregate
// `comments` counter. This covers all three --ignore-authors sources:
// conversation comments (unchanged behavior, renamed field), reviews
// (reviews[].author, no fetch needed -- already in the fingerprint), and
// thread replies (review-comments-added, needs threadReplyRows -- see the
// pre-publish pass in run() below; absent/undefined here means "not
// available," which fails open and is reported by the caller as an explicit
// warning, never silently).
function authorsIgnored(delta, ignoredAuthors, { threadReplyRows } = {}) {
  if (!ignoredAuthors?.length) return { delta, filtered: false };
  let classes = delta.classes;
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);

  if (classes.includes('new-comments')) {
    const increment = (toFp?.conversationComments ?? NaN) - (fromFp?.conversationComments ?? NaN);
    const rows = toFp?.recentComments;
    if (
      increment > 0 &&
      Array.isArray(rows) &&
      increment <= rows.length &&
      rows.slice(-increment).every((row) => row?.id && row?.author) &&
      allAuthorsIgnored(
        rows.slice(-increment).map((row) => row.author),
        ignoredAuthors,
      )
    ) {
      classes = classes.filter((klass) => klass !== 'new-comments');
    }
  }

  if (classes.includes('review-changed') && !reviewDecisionMoved(fromFp, toFp)) {
    const changed = changedOrNewReviews(fromFp, toFp);
    if (
      allAuthorsIgnored(
        changed.map((row) => row.author),
        ignoredAuthors,
      )
    ) {
      classes = classes.filter((klass) => klass !== 'review-changed');
    }
  }

  if (classes.includes('review-comments-added')) {
    const rows = threadReplyRows?.get(delta.id);
    if (rows) {
      const authors = rows.flatMap((thread) => thread.replies.map((reply) => reply.author));
      if (allAuthorsIgnored(authors, ignoredAuthors)) {
        classes = classes.filter((klass) => klass !== 'review-comments-added');
      }
    }
  }

  if (classes.length === delta.classes.length) return { delta, filtered: false };
  return { delta: classes.length ? { ...delta, classes } : null, filtered: true };
}

export {
  applyAttentionFilters,
  watchedTerminalTransitionSuppressed,
  authorsIgnored,
  isTerminalCleanupEligible,
};
