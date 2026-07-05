// Snapshot filesystem boundary. Missing snapshots seed a baseline; corrupt JSON is an error.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir as osTmpdir, userInfo as osUserInfo } from 'node:os';
import { canonicalEntityKey } from './args.mjs';

const encodeSegment = (label, value) =>
  `${label}-${encodeURIComponent(String(value)).replaceAll('_', '%5F')}`;

/**
 * Build a filesystem-safe snapshot filename scoped by repository, monitor, and entity
 * set.
 *
 * The result is deterministic for the same `(repo, monitorId, entities, baseDir)`
 * tuple and is safe to use across repeated monitor ticks.
 */
export function snapshotPath(repo, monitorId, entities, baseDir) {
  return `${baseDir}/${encodeSegment('repo', repo)}__${encodeSegment('monitor', monitorId)}__${canonicalEntityKey(entities)}.json`;
}

/**
 * Per-user default state directory under the system temp dir.
 *
 * Computes only — callers create it (the CLI does, with mode 0700). Temp
 * state is ephemeral by design: reboots or tmp cleanup silently re-seed the
 * baseline. Durable monitors should pass an explicit --state-dir.
 */
export function defaultStateDir({
  tmpdir = osTmpdir,
  userInfo = osUserInfo,
  env = process.env,
} = {}) {
  let name;
  try {
    name = userInfo().username;
  } catch {
    name = env.USER ?? env.USERNAME ?? 'user'; // containers without a user-db entry
  }
  return join(tmpdir(), `gh-delta-${encodeURIComponent(String(name)).replaceAll('_', '%5F')}`);
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
  if (Object.hasOwn(snapshot, 'meta') && !isPlainObject(snapshot.meta)) {
    throw new Error(`invalid snapshot shape at ${path}: meta must be an object when present`);
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

const HORIZON_OVERLAP_MS = 5 * 60 * 1000;

/**
 * Derive the incremental-fetch cutoff from a snapshot. Baseline (null snapshot)
 * returns null (open-phase-only fetch). Legacy snapshots without meta fall back
 * to the newest fingerprint updatedAt. The overlap absorbs clock skew between
 * GitHub and the detector; re-fetched unchanged items diff to zero deltas.
 */
export function horizonCutoff(oldSnapshot, overlapMs = HORIZON_OVERLAP_MS) {
  if (oldSnapshot == null) return null;
  let horizon = oldSnapshot.meta?.horizon ?? null;
  if (!horizon) {
    for (const family of ['pr', 'issue']) {
      for (const fp of Object.values(oldSnapshot[family] ?? {})) {
        if (typeof fp?.updatedAt === 'string' && (!horizon || fp.updatedAt > horizon)) {
          horizon = fp.updatedAt;
        }
      }
    }
  }
  if (!horizon) return null;
  return new Date(Date.parse(horizon) - overlapMs).toISOString();
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
 * @param {{fs?: {mkdirSync:any, writeFileSync:any, renameSync:any, unlinkSync:any}, uniqueSuffix?: ()=>string, dirMode?: number}} [deps]
 * @returns {void}
 */
export function writeSnapshotAtomic(path, data, deps = {}) {
  const fs = deps.fs ?? { mkdirSync, writeFileSync, renameSync, unlinkSync };
  const uniqueSuffix = deps.uniqueSuffix ?? (() => `${process.pid}.${Date.now()}.${randomUUID()}`);
  const dirMode = deps.dirMode;
  validateSnapshotShape(data, path); // never persist a snapshot the reader would reject
  fs.mkdirSync(dirname(path), { recursive: true, ...(dirMode ? { mode: dirMode } : {}) });
  const tmp = `${path}.${uniqueSuffix()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, path); // atomic on POSIX within one filesystem
  } catch (err) {
    try {
      fs.unlinkSync?.(tmp);
    } catch {
      // best-effort cleanup; the original rename error is the one that matters
    }
    throw err;
  }
}
