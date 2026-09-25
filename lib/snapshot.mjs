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
 * A watch-only PR universe has independent history from broad polling. Keep
 * the normal encoded repository/monitor identity for derived files, while an
 * explicit file gets a deterministic sibling rather than being overwritten.
 */
export function economicalSnapshotPath(repo, monitorId, entities, baseDir, { stateFile } = {}) {
  if (stateFile) return `${stateFile}.watch.json`;
  return `${baseDir}/${encodeSegment('repo', repo)}__${encodeSegment('monitor', monitorId)}__watch-pr.json`;
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

function isValidDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// The three sections of a snapshot item (schema v2). No other top-level key is
// permitted: `fingerprint` is exactly the compared fields, `context` is
// identity/display, `meta` is detector bookkeeping. See docs/contract.md
// "Snapshot Semantics".
const ITEM_SECTIONS = ['fingerprint', 'context', 'meta'];

function validateItemShape(item, path, family, key) {
  const label = `${family}.${key}`;
  if (!isPlainObject(item)) {
    throw new Error(`invalid snapshot shape at ${path}: ${label} must be an object`);
  }
  const unknown = Object.keys(item).filter((k) => !ITEM_SECTIONS.includes(k));
  if (unknown.length) {
    throw new Error(
      `invalid snapshot shape at ${path}: ${label} has unknown key(s): ${unknown.join(', ')}`,
    );
  }
  for (const section of ITEM_SECTIONS) {
    if (!isPlainObject(item[section])) {
      throw new Error(`invalid snapshot shape at ${path}: ${label}.${section} must be an object`);
    }
  }
  for (const field of ['seenAt', 'changedAt']) {
    const value = item.meta[field];
    if (Object.hasOwn(item.meta, field) && value != null && !isValidDateString(value)) {
      throw new Error(
        `invalid snapshot shape at ${path}: ${label}.meta.${field} must be an ISO date string when present`,
      );
    }
  }
}

// Schema v2 snapshot meta: mandatory, exactly these fields. No migration from
// an older or missing meta -- `gh-delta reset` is the documented recovery.
export const SNAPSHOT_SCHEMA_VERSION = 2;
const SNAPSHOT_META_FIELDS = [
  'schemaVersion',
  'ghDeltaVersion',
  'repo',
  'monitorId',
  'entities',
  'scope',
  'horizon',
  'createdAt',
  'updatedAt',
];
const SNAPSHOT_META_SCOPES = ['poll', 'watch-pr'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate the mandatory snapshot-wide `meta` block (schema v2). Any other
 * shape -- missing, an older `schemaVersion`, or a field set that doesn't
 * match exactly -- is rejected: there is no migration path, only
 * `gh-delta reset` to start a clean baseline.
 */
function validateSnapshotMeta(meta, path) {
  if (!isPlainObject(meta)) {
    throw new Error(
      `invalid snapshot shape at ${path}: meta is mandatory (schema v2); run \`gh-delta reset\` to start a clean baseline`,
    );
  }
  const keys = Object.keys(meta).sort().join(',');
  if (keys !== [...SNAPSHOT_META_FIELDS].sort().join(',')) {
    throw new Error(
      `invalid snapshot shape at ${path}: meta fields must be exactly ${SNAPSHOT_META_FIELDS.join(', ')}; run \`gh-delta reset\` to start a clean baseline`,
    );
  }
  if (meta.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `invalid snapshot shape at ${path}: unsupported meta.schemaVersion ${JSON.stringify(meta.schemaVersion)}; run \`gh-delta reset\` to start a clean baseline`,
    );
  }
  if (!nonEmptyString(meta.ghDeltaVersion)) {
    throw new Error(
      `invalid snapshot shape at ${path}: meta.ghDeltaVersion must be a non-empty string`,
    );
  }
  if (!nonEmptyString(meta.repo)) {
    throw new Error(`invalid snapshot shape at ${path}: meta.repo must be a non-empty string`);
  }
  if (!nonEmptyString(meta.monitorId)) {
    throw new Error(`invalid snapshot shape at ${path}: meta.monitorId must be a non-empty string`);
  }
  if (
    !Array.isArray(meta.entities) ||
    meta.entities.length === 0 ||
    meta.entities.some((entity) => typeof entity !== 'string')
  ) {
    throw new Error(
      `invalid snapshot shape at ${path}: meta.entities must be a non-empty array of strings`,
    );
  }
  if (!SNAPSHOT_META_SCOPES.includes(meta.scope)) {
    throw new Error(
      `invalid snapshot shape at ${path}: meta.scope must be one of ${SNAPSHOT_META_SCOPES.join(', ')}`,
    );
  }
  for (const field of ['horizon', 'createdAt', 'updatedAt']) {
    if (!isValidDateString(meta[field])) {
      throw new Error(
        `invalid snapshot shape at ${path}: meta.${field} must be an ISO date string`,
      );
    }
  }
}

/**
 * Assert a snapshot matches the on-disk contract, or throw with a located
 * message. Guards both boundaries: `readSnapshot` rejects corrupt files rather
 * than resetting watcher memory, and `writeSnapshotAtomic` refuses to persist
 * anything the reader would later reject. Requires `{ pr, issue, meta }`: `pr`
 * and `issue` are maps of numeric string keys to three-section items
 * (`fingerprint`/`context`/`meta`); the top-level `meta` is the mandatory
 * schema-v2 snapshot-wide block (see `validateSnapshotMeta`).
 *
 * @param {unknown} snapshot
 * @param {string} path
 * @returns {object} the validated snapshot, unchanged
 */
function validateSnapshotShape(snapshot, path) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.pr) || !isPlainObject(snapshot.issue)) {
    throw new Error(
      `invalid snapshot shape at ${path}: expected { pr: object, issue: object, meta: object }`,
    );
  }
  for (const family of ['pr', 'issue']) {
    for (const [key, value] of Object.entries(snapshot[family])) {
      if (!/^[0-9]+$/.test(key)) {
        throw new Error(
          `invalid snapshot shape at ${path}: expected ${family} map of numeric keys to objects`,
        );
      }
      validateItemShape(value, path, family, key);
    }
  }
  validateSnapshotMeta(snapshot.meta, path);
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
 * returns null (open-phase-only fetch). `meta.horizon` is mandatory on any
 * snapshot that passed `validateSnapshotShape`; no fallback derivation. The
 * overlap absorbs clock skew between GitHub and the detector; re-fetched
 * unchanged items diff to zero deltas.
 */
export function horizonCutoff(oldSnapshot, overlapMs = HORIZON_OVERLAP_MS) {
  if (oldSnapshot == null) return null;
  const horizon = oldSnapshot.meta?.horizon;
  if (!isValidDateString(horizon)) {
    throw new Error(`invalid snapshot horizon: ${horizon}`);
  }
  return new Date(Date.parse(horizon) - overlapMs).toISOString();
}

/**
 * Write a snapshot through a unique temp file and same-directory rename.
 *
 * The rename is atomic on POSIX when source and destination are on the same
 * filesystem. The unique temp name avoids collisions between overlapping
 * writers, though operators should still avoid concurrent ticks.
 *
 * `verifyBeforeCommit`, when given, is called immediately before the final
 * `renameSync` -- after JSON serialization and the temp-file write, which is
 * exactly the work callers want to avoid re-verifying ownership before
 * paying for. A `false` return aborts without writing anything (the temp
 * file is removed) and throws an error with `code: 'LOCK_LOST'`. This is
 * gh-delta's lock's pre-write fence, called a second time right at the
 * syscall boundary that actually publishes the snapshot -- see
 * lib/lock.mjs's `assertLockOwned` and docs/contract.md "Lock Semantics".
 *
 * @param {string} path
 * @param {Record<string, Record<string, unknown>>} data
 * @param {{fs?: {mkdirSync:any, writeFileSync:any, renameSync:any, unlinkSync:any}, uniqueSuffix?: ()=>string, dirMode?: number, verifyBeforeCommit?: () => boolean}} [deps]
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
  if (deps.verifyBeforeCommit && !deps.verifyBeforeCommit()) {
    try {
      fs.unlinkSync?.(tmp);
    } catch {
      // best-effort cleanup; the ownership-lost error below is what matters
    }
    const err = new Error(`ownership check failed immediately before commit for ${path}`);
    err.code = 'LOCK_LOST';
    throw err;
  }
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
