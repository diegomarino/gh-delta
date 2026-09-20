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
function valid(entry) {
  const keys = Object.keys(entry);
  return (
    entry &&
    typeof entry === 'object' &&
    ['pr', 'issue'].includes(entry.entity) &&
    Number.isSafeInteger(entry.number) &&
    entry.number > 0 &&
    typeof entry.addedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.addedAt)) &&
    (entry.until === 'closed' || (entry.entity === 'pr' && entry.until === 'merged')) &&
    (entry.repo === undefined ||
      (typeof entry.repo === 'string' &&
        validateRepo(entry.repo).ok &&
        validateRepo(entry.repo).repo === entry.repo)) &&
    (keys.length === 4 || (keys.length === 5 && entry.repo !== undefined))
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
