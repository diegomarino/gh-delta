// Local, monitor-private watch-list persistence.  This module deliberately has
// no GitHub dependency: callers validate/read it before a detector fetch.
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';
import { canonicalLabels, valid, watchFilename } from './watch-entry.mjs';
export { watchFilename } from './watch-entry.mjs';
import { atomic, writeTerminalIgnoredLocked } from './watch-lock.mjs';

const ITEM = /^(pr|issue):(\d+)$/;

export function watchDirPath(repo, monitorId, stateDir) {
  return join(stateDir, `watch-${encodeURIComponent(repo)}__${encodeURIComponent(monitorId)}.d`);
}

export function parseWatchItem(raw) {
  const match = ITEM.exec(String(raw));
  const number = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(number) || number < 1)
    throw new Error(
      `watch item must be pr:<positive number> or issue:<positive number>; got "${raw}"`,
    );
  return { entity: match[1], number };
}

function locked(path, fn) {
  const acquired = acquireLock(path, { ghTimeoutMs: 1000, staleMs: 30000 });
  if (!acquired.ok) throw new Error(`watch entry locked: ${path}`);
  try {
    return fn();
  } finally {
    releaseLock(path, acquired.token);
  }
}

export function readWatch(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  const seen = new Set();
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new Error(`invalid watch entry ${name}`);
    }
    if (!valid(entry)) throw new Error(`invalid watch entry ${name}`);
    const key = `${entry.repo ?? ''}:${entry.entity}:${entry.number}`;
    if (seen.has(key)) throw new Error(`duplicate watch entry ${name}`);
    seen.add(key);
    entries.push({ ...entry, __filename: name });
  }
  for (const entry of entries)
    if (watchFilename(entry) !== entry.__filename)
      throw new Error(`invalid watch entry ${entry.__filename}`);
  return entries
    .map(({ __filename, ...entry }) => entry)
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.number - b.number);
}

function labelsEqual(left, right) {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function withLabels(entry, labels) {
  if (labels && Object.keys(labels).length > 0) return { ...entry, labels };
  const { labels: _ignored, ...rest } = entry;
  return rest;
}

export function addWatch(
  dir,
  raw,
  until,
  { now = () => new Date().toISOString(), repo, labels } = {},
) {
  const item = parseWatchItem(raw);
  if (!['closed', 'merged'].includes(until) || (item.entity === 'issue' && until !== 'closed'))
    throw new Error(
      `--until must be ${item.entity === 'pr' ? 'merged or closed' : 'closed'} for ${item.entity}`,
    );
  const requested = labels === undefined ? undefined : canonicalLabels(labels);
  mkdirSync(dir, { recursive: true });
  const scoped = repo ? { ...item, repo } : item;
  const path = join(dir, watchFilename(scoped));
  return locked(path, () => {
    let existing;
    let parsed = false;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
      parsed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`invalid watch entry ${watchFilename(scoped)}`);
    }
    if (parsed) {
      const labelBearing =
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        Object.hasOwn(existing, 'labels');
      if (!valid(existing) && (requested !== undefined || labelBearing))
        throw new Error(`invalid watch entry ${watchFilename(scoped)}`);
      if (
        valid(existing) &&
        existing.entity === item.entity &&
        existing.number === item.number &&
        existing.repo === repo &&
        existing.until === until
      ) {
        const next = requested === undefined ? existing.labels : requested;
        const normalized = next && Object.keys(next).length > 0 ? next : undefined;
        if (labelsEqual(existing.labels, normalized))
          return { added: false, entry: existing, path };
        const entry = withLabels(existing, normalized);
        atomic(path, entry);
        return { added: true, entry, path };
      }
    }
    const carried =
      requested !== undefined ? requested : valid(existing) ? existing.labels : undefined;
    const entry = withLabels({ ...scoped, until, addedAt: now() }, carried);
    atomic(path, entry);
    return { added: true, entry, path };
  });
}
export function listWatch(dir) {
  return readWatch(dir);
}

export function removeWatch(dir, raw, { repo } = {}) {
  const item = parseWatchItem(raw);
  const path = join(dir, watchFilename(repo ? { ...item, repo } : item));
  return locked(path, () => {
    try {
      unlinkSync(path);
      return { removed: true, path };
    } catch (err) {
      if (err.code === 'ENOENT') return { removed: false, path };
      throw err;
    }
  });
}
export function removeWatchUnchanged(path, bytes) {
  return locked(path, () => {
    try {
      if (readFileSync(path, 'utf8') !== bytes) return false;
      unlinkSync(path);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  });
}

/**
 * Durably record that a watched item's terminal transition (a merge or
 * close matching its `until`) was observed but suppressed by the current
 * tick's attention filters, so a LATER, unrelated delta -- one carrying no
 * transition class of its own, because the state does not change twice --
 * does not silently clean up the entry while the same filter is still in
 * effect (see lib/cli/attention.mjs's isTerminalCleanupEligible/
 * watchedTerminalTransitionSuppressed). Most callers want this: acquire,
 * write, release, all in one call. The detector tick does not -- it needs to
 * hold the lock across the mark AND the snapshot publish together, so it
 * uses lib/watch-lock.mjs's writeTerminalIgnoredLocked/withTerminalMarkLocks
 * directly (internal, unpublished helpers -- see that module's header for
 * why writeTerminalIgnoredLocked in particular must never be a public
 * export: its contract, "the caller already holds this entry's lock", is
 * not something a published signature can express or verify).
 */
export function markTerminalIgnored(path, bytes, ignoredAt) {
  return locked(path, () => writeTerminalIgnoredLocked(path, bytes, ignoredAt));
}
