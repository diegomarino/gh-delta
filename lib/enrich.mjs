// Opt-in report decoration performed after durable state publication.  The
// detector has already decided which deltas survive; this module must never
// alter their identity, classes, or the canonical snapshot/log stream.
import { threadSetDiff } from './detect.mjs';

function changedReviews(delta) {
  if (!delta.classes.includes('review-changed') || !Array.isArray(delta.to?.reviewDetails))
    return null;
  const old = new Map(
    (Array.isArray(delta.from?.reviewDetails) ? delta.from.reviewDetails : [])
      .filter((row) => row?.id)
      .map((row) => [row.id, JSON.stringify(row)]),
  );
  const ids = delta.to.reviewDetails
    .filter(
      (row) =>
        row?.id && row.state === 'CHANGES_REQUESTED' && old.get(row.id) !== JSON.stringify(row),
    )
    .map((row) => row.id);
  return ids.length ? [...new Set(ids)].sort() : null;
}

function addedComments(delta) {
  if (!delta.classes.includes('new-comments')) return null;
  const from = delta.from;
  const to = delta.to;
  // A newly observed item legitimately has no prior bounded window when its
  // persisted conversation count is exactly zero. Any nonzero/unknown prior
  // count remains opaque: treating it as empty could fetch the wrong bodies.
  const oldNodes = Array.isArray(from?.commentNodes)
    ? from.commentNodes
    : from?.conversationComments === 0
      ? []
      : null;
  if (!oldNodes || !Array.isArray(to?.commentNodes)) return null;
  const increment = to.conversationComments - from.conversationComments;
  if (!Number.isSafeInteger(increment) || increment <= 0 || increment > to.commentNodes.length)
    return null;
  const rows = to.commentNodes.slice(-increment);
  if (rows.some((row) => typeof row?.id !== 'string' || !row.id)) return null;
  return [...new Set(rows.map((row) => row.id))].sort();
}

function addedThreads(delta) {
  if (!delta.classes.includes('unresolved-threads-added')) return null;
  const { addedIds } = threadSetDiff(delta.from?.threadStates, delta.to?.threadStates);
  return addedIds.length ? addedIds : null;
}

const IDENTITIES = { review: changedReviews, comments: addedComments, threads: addedThreads };

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

/**
 * Decorate already-emitted deltas. `fetch(kind, ids)` is deliberately sync:
 * the underlying gh CLI boundary is sync and a failure is only a warning.
 */
export function enrichEmittedDeltas(deltas, kinds, { fetch }) {
  const warnings = [];
  for (const delta of deltas) {
    const attached = {};
    for (const kind of kinds) {
      const ids = IDENTITIES[kind]?.(delta);
      if (!ids) {
        // A selected kind that matched a delta class but lacks durable identity
        // is an explicit opaque transition, not permission to guess/fetch.
        if (
          delta.classes.some(
            (klass) =>
              ({
                review: 'review-changed',
                comments: 'new-comments',
                threads: 'unresolved-threads-added',
              })[kind] === klass,
          )
        )
          warnings.push(warning(kind, 'emitted delta lacks usable persisted identities; skipped'));
        continue;
      }
      try {
        const rows = fetch(kind, ids);
        if (!Array.isArray(rows) || rows.length === 0)
          throw new Error('returned no enrichment rows');
        attached[kind] =
          kind === 'comments'
            ? rows.map((row) => ({ ...row, mentions: extractMentions(row.body) }))
            : rows;
      } catch (err) {
        warnings.push(warning(kind, String(err?.message ?? err)));
      }
    }
    if (Object.keys(attached).length) delta.enrichment = attached;
  }
  return warnings;
}
