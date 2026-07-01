// Stable object fingerprints for change detection. These intentionally avoid
// storing large GitHub payloads such as full comment bodies.
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const COMMENT_ARRAY_CAP = 100;

// A statusCheckRollup entry is either a CheckRun {name,status,conclusion}
// or a StatusContext {context,state}. Normalize both, sort by name, hash.
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

export function hashReviews(latestReviews = []) {
  const tuples = (latestReviews ?? []).map(
    (r) => `${r.id ?? ''}:${r.submittedAt ?? ''}:${r.author?.login ?? '?'}:${r.state ?? ''}:${r.commit?.oid ?? ''}`,
  );
  tuples.sort();
  return sha1(tuples.join('|'));
}

export function prFingerprint(pr) {
  const comments = (pr.comments ?? []).length;
  return {
    state: pr.state,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft ?? false,
    ci: canonicalizeCiRollup(pr.statusCheckRollup),
    review: pr.reviewDecision ?? '',
    reviews: hashReviews(pr.latestReviews),
    mergeable: pr.mergeable ?? 'UNKNOWN',
    // gh pr list --json exposes `comments` (array), NOT the GraphQL scalar
    // totalCommentsCount; count length to match the issue path.
    comments,
    commentsOverflow: comments >= COMMENT_ARRAY_CAP,
    head: pr.headRefOid ?? '',
  };
}

export function issueFingerprint(issue) {
  const comments = (issue.comments ?? []).length;
  return {
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: (issue.labels ?? []).map((l) => l.name).sort(),
    comments,
    commentsOverflow: comments >= COMMENT_ARRAY_CAP,
  };
}
