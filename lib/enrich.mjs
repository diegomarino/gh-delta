// Opt-in report decoration performed after durable state publication.  The
// detector has already decided which deltas survive; this module must never
// alter their identity, classes, or the canonical snapshot/log stream.
import { threadSetDiff } from './detect.mjs';

function changedReviews(delta) {
  const from = delta.from?.fingerprint;
  const to = delta.to?.fingerprint;
  if (!delta.classes.includes('review-changed') || !Array.isArray(to?.reviews)) return null;
  const old = new Map(
    (Array.isArray(from?.reviews) ? from.reviews : [])
      .filter((row) => row?.id)
      .map((row) => [row.id, JSON.stringify(row)]),
  );
  const ids = to.reviews
    .filter(
      (row) =>
        row?.id && row.state === 'changes_requested' && old.get(row.id) !== JSON.stringify(row),
    )
    .map((row) => row.id);
  return ids.length ? [...new Set(ids)].sort() : null;
}

function addedComments(delta) {
  if (!delta.classes.includes('new-comments')) return null;
  const from = delta.from?.fingerprint;
  const to = delta.to?.fingerprint;
  // A newly observed item legitimately has no prior bounded window when its
  // persisted conversation count is exactly zero. Any nonzero/unknown prior
  // count remains opaque: treating it as empty could fetch the wrong bodies.
  const oldNodes = Array.isArray(from?.recentComments)
    ? from.recentComments
    : from?.conversationComments === 0
      ? []
      : null;
  if (!oldNodes || !Array.isArray(to?.recentComments)) return null;
  const increment = to.conversationComments - from.conversationComments;
  if (!Number.isSafeInteger(increment) || increment <= 0 || increment > to.recentComments.length)
    return null;
  const rows = to.recentComments.slice(-increment);
  if (rows.some((row) => typeof row?.id !== 'string' || !row.id)) return null;
  return [...new Set(rows.map((row) => row.id))].sort();
}

function addedThreads(delta) {
  if (!delta.classes.includes('unresolved-threads-added')) return null;
  const { addedIds } = threadSetDiff(
    delta.from?.fingerprint?.threads,
    delta.to?.fingerprint?.threads,
  );
  return addedIds.length ? addedIds : null;
}

// `body` enrichment fetches the item's own body, not a child object's, so its
// identity is the item's GraphQL node id (delta.to.context.id) -- available
// only for classes that carry a freshly observed object. Explicitly excludes
// plain `updated` (F2 scope boundary: not implemented in 0.7.0).
const BODY_CLASSES = ['new', 'first-seen', 'reopened', 'baseline-state'];
function bodyIdentity(delta) {
  if (!BODY_CLASSES.some((klass) => delta.classes.includes(klass))) return null;
  const id = delta.to?.context?.id;
  return typeof id === 'string' && id ? [id] : null;
}

const IDENTITIES = {
  review: changedReviews,
  comments: addedComments,
  threads: addedThreads,
  body: bodyIdentity,
};

// Maps each enrichment kind to the class(es) that make its identity function
// possibly-applicable, so a null identity for a matching class is reported as
// an opaque-transition warning instead of silently skipped.
const REQUIRED_CLASSES = {
  review: ['review-changed'],
  comments: ['new-comments'],
  threads: ['unresolved-threads-added'],
  body: BODY_CLASSES,
};

/** Extract GitHub-style @user and @org/team mentions in first-seen order. */
export function extractMentions(body) {
  const result = [];
  const seen = new Set();
  // The prefix excludes email local parts and identifier continuations. GitHub
  // logins cannot start/end with a hyphen; team slugs follow the same shape.
  const pattern =
    /(^|[^A-Za-z0-9_.+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)?)/g;
  for (const match of String(body).matchAll(pattern)) {
    const token = match[2];
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(token);
    }
  }
  return result;
}

function warning(kind, reason) {
  return { label: `enrichment ${kind}`, reason };
}

// Sum `cost` across every enrichment call this tick made; keep the last
// observed `remaining`/`resetAt`. Mirrors lib/gh.mjs's accumulateRateLimit.
function accumulateRateLimit(a, b) {
  if (!b) return a;
  if (!a) return b;
  return { cost: a.cost + b.cost, remaining: b.remaining, resetAt: b.resetAt };
}

/**
 * Decorate already-emitted deltas. `fetch(kind, ids)` is deliberately sync:
 * the underlying gh CLI boundary is sync and a failure is only a warning. It
 * returns `{ rows, rateLimit }` (see lib/gh.mjs's fetchEnrichment); this
 * accumulates `rateLimit` across every call alongside the existing warnings.
 */
export function enrichEmittedDeltas(deltas, kinds, { fetch }) {
  const warnings = [];
  let rateLimit = null;
  for (const delta of deltas) {
    const attached = {};
    for (const kind of kinds) {
      const ids = IDENTITIES[kind]?.(delta);
      if (!ids) {
        // A selected kind that matched a delta class but lacks durable identity
        // is an explicit opaque transition, not permission to guess/fetch.
        if (delta.classes.some((klass) => REQUIRED_CLASSES[kind]?.includes(klass)))
          warnings.push(warning(kind, 'emitted delta lacks usable persisted identities; skipped'));
        continue;
      }
      try {
        const { rows, rateLimit: callRateLimit } = fetch(kind, ids);
        rateLimit = accumulateRateLimit(rateLimit, callRateLimit);
        if (!Array.isArray(rows) || rows.length === 0)
          throw new Error('returned no enrichment rows');
        attached[kind] =
          kind === 'comments'
            ? rows.map((row) => ({ ...row, mentions: extractMentions(row.body) }))
            : kind === 'body'
              ? { body: rows[0].body, mentions: extractMentions(rows[0].body) }
              : rows;
      } catch (err) {
        warnings.push(warning(kind, String(err?.message ?? err)));
      }
    }
    if (Object.keys(attached).length) delta.enrichment = attached;
  }
  return { warnings, rateLimit };
}
