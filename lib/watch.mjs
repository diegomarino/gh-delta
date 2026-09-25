// Local, monitor-private watch-list persistence.  This module deliberately has
// no GitHub dependency: callers validate/read it before a detector fetch.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';
import { validateRepo } from './args.mjs';

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

export function watchFilename(entry) {
  return entry.repo
    ? `repo-${encodeURIComponent(entry.repo)}__${entry.entity}-${entry.number}.json`
    : `${entry.entity}-${entry.number}.json`;
}
// Canonical watch entry shape: `{entity, number, until, addedAt}`, plus two
// OPTIONAL fields, `repo` (scoping) and `ignoredTerminalAt` (see
// markTerminalIgnored below). The key-count check stays exact -- an unknown
// extra key is rejected, not silently tolerated -- so "canonical" keeps
// meaning something; only the SET of allowed optional keys grew.
//
// An entry written before `ignoredTerminalAt` existed simply lacks the key.
// That is deliberately treated as valid, not as a shape to reject or
// migrate: unlike a snapshot or delta log (which the project's "no
// migration" stance applies to), a watch entry is cheap, disposable
// operator state a person creates with `watch add` -- forcing everyone to
// recreate their watch list on upgrade would be pure friction for a field
// whose absence has an exact, correct meaning ("no terminal transition has
// ever been ignored for this entry yet").
function valid(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hasRepo = entry.repo !== undefined;
  const hasIgnoredTerminalAt = entry.ignoredTerminalAt !== undefined;
  const expectedKeys = 4 + (hasRepo ? 1 : 0) + (hasIgnoredTerminalAt ? 1 : 0);
  return (
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
function atomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
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

export function addWatch(dir, raw, until, { now = () => new Date().toISOString(), repo } = {}) {
  const item = parseWatchItem(raw);
  if (!['closed', 'merged'].includes(until) || (item.entity === 'issue' && until !== 'closed'))
    throw new Error(
      `--until must be ${item.entity === 'pr' ? 'merged or closed' : 'closed'} for ${item.entity}`,
    );
  mkdirSync(dir, { recursive: true });
  const scoped = repo ? { ...item, repo } : item;
  const path = join(dir, watchFilename(scoped));
  return locked(path, () => {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (
        valid(existing) &&
        existing.entity === item.entity &&
        existing.number === item.number &&
        existing.repo === repo &&
        existing.until === until
      )
        return { added: false, entry: existing, path };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`invalid watch entry ${watchFilename(scoped)}`);
    }
    const entry = { ...scoped, until, addedAt: now() };
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
 * effect (see lib/cli.mjs's isTerminalCleanupEligible/
 * watchedTerminalTransitionFilteredThisTick).
 *
 * Idempotent FIRST: a call against an entry that already carries
 * `ignoredTerminalAt` succeeds immediately without comparing bytes or
 * touching the file -- a second watched transition detected in the same
 * tick (or a retry after a partial failure) always finds "already marked"
 * regardless of whether the bytes it read have since gone stale from the
 * FIRST mark's own write. Only an entry that still needs marking goes
 * through the same compare-then-mutate shape as removeWatchUnchanged:
 * locked, and a no-op (returning `false`) if the on-disk bytes no longer
 * match what this tick read at the start (a concurrent `watch rm`/`watch
 * add`/another monitor process replaced the entry -- never clobber that).
 */
export function markTerminalIgnored(path, bytes, ignoredAt) {
  return locked(path, () => {
    try {
      const raw = readFileSync(path, 'utf8');
      const entry = JSON.parse(raw);
      if (entry.ignoredTerminalAt !== undefined) return true;
      if (raw !== bytes) return false;
      atomic(path, { ...entry, ignoredTerminalAt: ignoredAt });
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  });
}
