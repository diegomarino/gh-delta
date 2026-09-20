// Pure, bounded semantic differences for agent output. This deliberately never
// exposes fingerprint implementation digests or volatile observation metadata.
import { deriveCiRollup } from './summary.mjs';

const OMIT = new Set([
  'updatedAt',
  'missing',
  'missingTicks',
  'reviews',
  'threadDigest',
  'ciDetails',
  'reviewDetails',
  'commentNodes',
  'conversationComments',
]);
const SET_FIELDS = new Set(['labels', 'assignees', 'reviewRequests']);

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function capped(values, limit) {
  const sorted = [...values].sort();
  return { values: sorted.slice(0, limit), truncated: sorted.length > limit };
}
function setDiff(from, to, limit) {
  const a = new Set(Array.isArray(from) ? from.map(String) : []);
  const b = new Set(Array.isArray(to) ? to.map(String) : []);
  const added = capped(
    [...b].filter((x) => !a.has(x)),
    limit,
  );
  const removed = capped(
    [...a].filter((x) => !b.has(x)),
    limit,
  );
  const result = {};
  if (added.values.length) result.added = added.values;
  if (removed.values.length) result.removed = removed.values;
  if (added.truncated || removed.truncated) result.truncated = true;
  return result;
}
function identity(row, field) {
  if (field === 'threadStates') return String(row?.id ?? '');
  return `${row?.author ?? ''}\u0000${row?.submittedAt ?? ''}\u0000${row?.commit ?? ''}`;
}
function identityDiff(from, to, field, limit) {
  const before = new Map(
    (Array.isArray(from) ? from : []).map((row) => [identity(row, field), row]),
  );
  const after = new Map((Array.isArray(to) ? to : []).map((row) => [identity(row, field), row]));
  const added = [],
    removed = [],
    changed = [];
  for (const [key, row] of after) {
    if (!before.has(key)) added.push(key);
    else if (!same(before.get(key), row)) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  const out = {};
  for (const [name, rows] of Object.entries({ added, removed, changed })) {
    const cap = capped(rows, limit);
    if (cap.values.length) out[name] = cap.values;
    if (cap.truncated) out.truncated = true;
  }
  return out;
}
function ciChecksDiff(from, to, limit) {
  const before = new Map((Array.isArray(from) ? from : []).map((row) => [row.name, row]));
  const after = new Map((Array.isArray(to) ? to : []).map((row) => [row.name, row]));
  const failed = [],
    fixed = [],
    changed = [];
  const bad = (row) => deriveCiRollup(row ? [row] : []) === 'failed';
  for (const [name, row] of after) {
    const old = before.get(name);
    if (!old) {
      if (bad(row)) failed.push(name);
      else changed.push(name);
    } else if (!same(old, row)) {
      if (!bad(old) && bad(row)) failed.push(name);
      else if (bad(old) && !bad(row)) fixed.push(name);
      else changed.push(name);
    }
  }
  for (const [name, row] of before) if (!after.has(name)) (bad(row) ? fixed : changed).push(name);
  const out = {};
  for (const [name, rows] of Object.entries({ failed, fixed, changed })) {
    const cap = capped(rows, limit);
    if (cap.values.length) out[name] = cap.values;
    if (cap.truncated) out.truncated = true;
  }
  return out;
}

/** Return a stable, safe diff without modifying either fingerprint. */
export function diffFingerprint(from, to, { arrayLimit = 20 } = {}) {
  if (!Number.isSafeInteger(arrayLimit) || arrayLimit < 0) {
    throw new TypeError('arrayLimit must be a non-negative safe integer');
  }
  const left = from && typeof from === 'object' ? from : {};
  const right = to && typeof to === 'object' ? to : {};
  const output = {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (Object.hasOwn(left, 'ciChecks') || Object.hasOwn(right, 'ciChecks')) keys.add('ci');
  for (const key of [...keys].sort()) {
    if (OMIT.has(key)) continue;
    const a = Object.hasOwn(left, key) ? left[key] : null;
    const b = Object.hasOwn(right, key) ? right[key] : null;
    if (key === 'ciChecks') {
      const value = ciChecksDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (key === 'reviewSummary' || key === 'threadStates') {
      const value = identityDiff(a, b, key, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (SET_FIELDS.has(key)) {
      const value = setDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (key === 'ci') {
      const value = { from: deriveCiRollup(left.ciChecks), to: deriveCiRollup(right.ciChecks) };
      if (value.from !== value.to) output.ci = value;
    } else if (Array.isArray(a) || Array.isArray(b)) {
      const value = setDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (!same(a, b)) output[key] = { from: a ?? null, to: b ?? null };
  }
  return output;
}
