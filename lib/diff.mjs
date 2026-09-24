// Pure, bounded semantic differences for agent output.
import { deriveCiRollup } from './summary.mjs';

const SET_FIELDS = new Set(['labels', 'assignees', 'reviewRequests']);
// Identity-keyed array fields: every row carries a stable `id`, so the diff
// names exactly which rows were added, removed, or changed instead of
// reporting the whole array as opaque.
const IDENTITY_FIELDS = new Set(['reviews', 'threads', 'recentComments']);

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
function identity(row) {
  return String(row?.id ?? '');
}
function identityDiff(from, to, limit) {
  const before = new Map((Array.isArray(from) ? from : []).map((row) => [identity(row), row]));
  const after = new Map((Array.isArray(to) ? to : []).map((row) => [identity(row), row]));
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
// Returns null when either side repeats a check name (e.g. a CheckRun and a
// StatusContext sharing one name, or a matrix job re-run): the name-keyed
// maps would silently collapse the duplicates and misreport the
// failed/fixed/changed breakdown, so the caller must fall back to
// { opaque: true } instead -- mirrors diffSummaries() below for the same
// reason.
function checksDiff(from, to, limit) {
  const fromRows = Array.isArray(from) ? from : [];
  const toRows = Array.isArray(to) ? to : [];
  const before = new Map(fromRows.map((row) => [row.name, row]));
  const after = new Map(toRows.map((row) => [row.name, row]));
  if (before.size !== fromRows.length || after.size !== toRows.length) return null;
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
  for (const key of [...keys].sort()) {
    const a = Object.hasOwn(left, key) ? left[key] : null;
    const b = Object.hasOwn(right, key) ? right[key] : null;
    if (key === 'checks') {
      const value = checksDiff(a, b, arrayLimit);
      if (value === null) output[key] = { opaque: true };
      else if (Object.keys(value).length) output[key] = value;
    } else if (IDENTITY_FIELDS.has(key)) {
      const value = identityDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (SET_FIELDS.has(key)) {
      const value = setDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (Array.isArray(a) || Array.isArray(b)) {
      const value = setDiff(a, b, arrayLimit);
      if (Object.keys(value).length) output[key] = value;
    } else if (!same(a, b)) output[key] = { from: a ?? null, to: b ?? null };
  }
  return output;
}
