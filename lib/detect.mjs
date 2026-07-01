// Pure delta classifier. It compares old fingerprints to current GitHub objects
// and emits semantic classes without doing any I/O.
import { prFingerprint, issueFingerprint } from './fingerprint.mjs';

function classifyPr(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'MERGED') c.push('merged');
    else if (fp.state === 'CLOSED') c.push('closed');
    else if (fp.state === 'OPEN') c.push('reopened');
  }
  if (oldFp.isDraft === true && fp.isDraft === false) c.push('draft-ready');
  if (oldFp.ci !== fp.ci) c.push('ci-changed');
  if (oldFp.review !== fp.review || oldFp.reviews !== fp.reviews) c.push('review-changed');
  // Only a real mergeability resolution counts; UNKNOWN is a mid-recompute placeholder.
  if (fp.mergeable === 'MERGEABLE' && oldFp.mergeable === 'CONFLICTING') c.push('became-mergeable');
  if (fp.comments > oldFp.comments) c.push('new-comments');
  if (fp.commentsOverflow && oldFp.commentsOverflow && fp.updatedAt !== oldFp.updatedAt)
    c.push('new-comments');
  return c;
}

function classifyIssue(oldFp, fp) {
  const c = [];
  if (oldFp.state !== fp.state) {
    if (fp.state === 'CLOSED') c.push('closed');
    else if (fp.state === 'OPEN') c.push('reopened');
  }
  if (JSON.stringify(oldFp.labels) !== JSON.stringify(fp.labels)) c.push('relabeled');
  if (fp.comments > oldFp.comments) c.push('new-comments');
  if (fp.commentsOverflow && oldFp.commentsOverflow && fp.updatedAt !== oldFp.updatedAt)
    c.push('new-comments');
  return c;
}

function comparableFingerprint(fp) {
  // Snapshots written before comment overflow tracking do not have this field.
  // Treat the absence as the old implicit value so upgrades do not emit noise.
  if (fp && !Object.hasOwn(fp, 'commentsOverflow')) return { ...fp, commentsOverflow: false };
  return fp;
}

function stableValue(value) {
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

function fingerprintChanged(a, b) {
  return (
    JSON.stringify(stableValue(comparableFingerprint(a))) !==
    JSON.stringify(stableValue(comparableFingerprint(b)))
  );
}

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
      // Missing old fingerprint means this object appeared after the baseline.
      deltas.push({
        entity: kind,
        number: obj.number,
        title: obj.title,
        classes: ['new'],
        from: null,
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
      classes,
      from: oldFp,
      to: fp,
    });
  }
  for (const [key, oldFp] of Object.entries(oldMap)) {
    if (seen.has(key)) continue;
    // A fetched collection that omits an old object is suspicious: pagination,
    // permissions, or scope drift can otherwise erase watcher memory silently.
    const classes = oldFp.missing ? ['still-missing'] : ['missing'];
    nextMap[key] = { ...oldFp, missing: true };
    deltas.push({
      entity: kind,
      number: Number(key),
      title: '(missing from current fetch)',
      classes,
      from: oldFp,
      to: null,
    });
  }
  return { deltas, nextMap };
}

/**
 * Compare a previous snapshot with the current GitHub fetch.
 *
 * Missing old snapshots seed a baseline with no deltas. Fetched collections are
 * authoritative only for their entity family; omitted families are preserved so
 * partial `--entities` runs do not erase watcher memory.
 */
export function detectDeltas(oldSnapshot, current) {
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
  const deltas = baseline ? [] : [...prRes.deltas, ...issueRes.deltas];
  return { baseline, deltas, snapshot };
}
