// Snapshot filesystem boundary. Missing snapshots seed a baseline; corrupt JSON is an error.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const ENTITY_ORDER = ['pr', 'issue'];

const encodeSegment = (label, value) => `${label}-${encodeURIComponent(String(value))}`;

function entityKey(entities) {
  const tokens = String(entities)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const known = ENTITY_ORDER.filter((entity) => tokens.includes(entity));
  return known.length ? known.join('-') : tokens.join('-');
}

/**
 * Build a filesystem-safe snapshot filename scoped by repository, monitor, and entity
 * set.
 *
 * The result is deterministic for the same `(repo, monitorId, entities, baseDir)`
 * tuple and is safe to use across repeated monitor ticks.
 */
export function snapshotPath(repo, monitorId, entities, baseDir) {
  return `${baseDir}/${encodeSegment('repo', repo)}__${encodeSegment('monitor', monitorId)}__${entityKey(entities)}.json`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSnapshotShape(snapshot, path) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.pr) || !isPlainObject(snapshot.issue)) {
    throw new Error(`invalid snapshot shape at ${path}: expected { pr: object, issue: object }`);
  }
  for (const family of ['pr', 'issue']) {
    for (const [key, value] of Object.entries(snapshot[family])) {
      if (!/^[0-9]+$/.test(key) || !isPlainObject(value)) {
        throw new Error(
          `invalid snapshot shape at ${path}: expected ${family} map of numeric keys to objects`,
        );
      }
    }
  }
  return snapshot;
}

/**
 * Read a snapshot from disk.
 *
 * Missing files return `null` so callers can seed a baseline. Corrupt JSON is a
 * hard error because silently resetting watcher memory would create false
 * deltas later.
 */
export function readSnapshot(path) {
  try {
    return validateSnapshotShape(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError)
      throw new Error(`invalid snapshot JSON at ${path}: ${err.message}`);
    throw err;
  }
}

/**
 * Write a snapshot through a unique temp file and same-directory rename.
 *
 * The rename is atomic on POSIX when source and destination are on the same
 * filesystem. The unique temp name avoids collisions between overlapping
 * writers, though operators should still avoid concurrent ticks.
 *
 * @param {string} path
 * @param {Record<string, Record<string, unknown>>} data
 * @param {{fs?: {mkdirSync:any, writeFileSync:any, renameSync:any}, uniqueSuffix?: ()=>string}} [deps]
 * @returns {void}
 */
export function writeSnapshotAtomic(path, data, deps = {}) {
  const fs = deps.fs ?? { mkdirSync, writeFileSync, renameSync };
  const uniqueSuffix = deps.uniqueSuffix ?? (() => `${process.pid}.${Date.now()}.${randomUUID()}`);
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${uniqueSuffix()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path); // atomic on POSIX within one filesystem
}
