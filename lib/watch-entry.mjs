// Internal watch-entry validation and accepted tick views; not a published API.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRepo } from './args.mjs';

export function watchFilename(entry) {
  return entry.repo
    ? `repo-${encodeURIComponent(entry.repo)}__${entry.entity}-${entry.number}.json`
    : `${entry.entity}-${entry.number}.json`;
}
// Canonical watch entry shape: `{entity, number, until, addedAt}`, plus three
// OPTIONAL fields: `repo` (scoping), `ignoredTerminalAt` (see
// watch.mjs:markTerminalIgnored), and `labels` (local routing map from
// canonicalLabels). The key-count check stays exact -- an unknown extra
// key is rejected, not silently tolerated -- so "canonical" keeps meaning
// something; only the SET of allowed optional keys grew.
//
// An entry written before `ignoredTerminalAt` existed simply lacks the key.
// That is deliberately treated as valid, not as a shape to reject or
// migrate: unlike a snapshot or delta log (which the project's "no
// migration" stance applies to), a watch entry is cheap, disposable
// operator state a person creates with `watch add` -- forcing everyone to
// recreate their watch list on upgrade would be pure friction for a field
// whose absence has an exact, correct meaning ("no terminal transition has
// ever been ignored for this entry yet").
const LABEL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;
const RESERVED_LABEL_KEYS = new Set(['until', 'repo', '__proto__', 'constructor', 'prototype']);

export function canonicalLabels(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('labels must be a plain object');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new Error('labels must be a plain object');
  const keys = Object.keys(input);
  if (keys.length > 8) throw new Error('at most 8 labels');
  const labels = {};
  for (const key of [...keys].sort()) {
    if (RESERVED_LABEL_KEYS.has(key) || !LABEL_KEY.test(key))
      throw new Error(`invalid label key ${key}`);
    const value = input[key];
    if (typeof value !== 'string' || !LABEL_VALUE.test(value))
      throw new Error(`invalid label value for ${key}`);
    labels[key] = value;
  }
  return labels;
}

export function valid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const hasRepo = entry.repo !== undefined;
  const hasIgnoredTerminalAt = entry.ignoredTerminalAt !== undefined;
  const hasLabels = entry.labels !== undefined;
  const expectedKeys = 4 + (hasRepo ? 1 : 0) + (hasIgnoredTerminalAt ? 1 : 0) + (hasLabels ? 1 : 0);
  let labelsOk = true;
  if (hasLabels) {
    try {
      const canonical = canonicalLabels(entry.labels);
      labelsOk =
        Object.keys(canonical).length > 0 &&
        JSON.stringify(canonical) === JSON.stringify(entry.labels);
    } catch {
      labelsOk = false;
    }
  }
  return (
    labelsOk &&
    ['pr', 'issue'].includes(entry.entity) &&
    Number.isSafeInteger(entry.number) &&
    entry.number > 0 &&
    typeof entry.addedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.addedAt)) &&
    (entry.until === 'closed' || (entry.entity === 'pr' && entry.until === 'merged')) &&
    (!hasRepo ||
      (typeof entry.repo === 'string' &&
        validateRepo(entry.repo).ok &&
        validateRepo(entry.repo).repo === entry.repo)) &&
    (!hasIgnoredTerminalAt ||
      (typeof entry.ignoredTerminalAt === 'string' &&
        !Number.isNaN(Date.parse(entry.ignoredTerminalAt)))) &&
    Object.keys(entry).length === expectedKeys
  );
}
export function captureWatchFiles(dir, entries) {
  return entries.map((listed) => {
    const path = join(dir, watchFilename(listed));
    let bytes;
    try {
      bytes = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`invalid watch entry ${path}`);
    }
    let entry;
    try {
      entry = JSON.parse(bytes);
    } catch {
      throw new Error(`invalid watch entry ${path}`);
    }
    if (!valid(entry) || watchFilename(entry) !== watchFilename(listed))
      throw new Error(`invalid watch entry ${path}`);
    return { entry, path, bytes };
  });
}
