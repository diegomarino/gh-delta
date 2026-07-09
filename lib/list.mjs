// Read-only monitor inventory. Discovers monitors two ways — scanning a state
// directory (derived filenames, or self-describing snapshot meta for arbitrary
// names) and reading the run registry — merges them by snapshot path, never
// contacts GitHub, and never writes: a corrupt snapshot becomes an entry with
// `error`, a registered snapshot that vanished becomes an entry with `stale`.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSnapshot } from './snapshot.mjs';
import { canonicalStateFileKey, readRegistry } from './registry.mjs';

// Derived snapshot filenames never contain a literal `_` inside a segment
// (snapshotPath encodes `_` as %5F), so `__` is an unambiguous separator.
const SNAPSHOT_FILENAME = /^repo-([^_]+)__monitor-([^_]+)__([^_]+)\.json$/;
const SINCE_GRAMMAR = /^([0-9]+)([smhd])$/;
const SINCE_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a `--since` duration like `90s`, `15m`, `24h`, or `7d` into milliseconds.
 *
 * @param {string|unknown} raw
 * @returns {{ ms: number } | { error: string }}
 */
export function parseSince(raw) {
  const match = SINCE_GRAMMAR.exec(String(raw ?? ''));
  const value = match ? Number(match[1]) : 0;
  if (!match || value <= 0) {
    return {
      error: `--since must be a positive integer followed by s, m, h, or d (e.g. 24h); got "${raw}"`,
    };
  }
  return { ms: value * SINCE_UNIT_MS[match[2]] };
}

/**
 * Decode a derived snapshot filename back into its identity, or return `null`
 * for files that were not produced by `snapshotPath` (explicit `--state-file`
 * snapshots, foreign files, temp leftovers).
 *
 * @param {string} filename - Basename, not a path.
 * @returns {{ repo: string, monitorId: string, entities: string[] } | null}
 */
export function parseSnapshotFilename(filename) {
  const match = SNAPSHOT_FILENAME.exec(filename);
  if (!match) return null;
  try {
    return {
      repo: decodeURIComponent(match[1]),
      monitorId: decodeURIComponent(match[2]),
      entities: match[3].split('-'),
    };
  } catch {
    return null; // malformed percent-encoding: not one of ours
  }
}

// Identity stamped inside the snapshot by the detector (self-describing
// snapshots). Lets the scan recognize --state-file snapshots whose filename
// carries no identity.
function metaIdentity(snapshot) {
  const meta = snapshot?.meta;
  if (
    meta &&
    typeof meta.repo === 'string' &&
    typeof meta.monitorId === 'string' &&
    Array.isArray(meta.entities) &&
    meta.entities.every((entity) => typeof entity === 'string')
  ) {
    return { repo: meta.repo, monitorId: meta.monitorId, entities: meta.entities };
  }
  return null;
}

function scanStateDir(stateDir, byPath) {
  let names;
  try {
    names = readdirSync(stateDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  let skippedFiles = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      skippedFiles++;
      continue;
    }
    const stateFile = join(stateDir, name);
    let snapshot = null;
    let readError = null;
    try {
      snapshot = readSnapshot(stateFile);
    } catch (err) {
      readError = String(err?.message ?? err);
    }
    if (snapshot == null && readError == null) continue; // vanished mid-scan
    const identity = parseSnapshotFilename(name) ?? metaIdentity(snapshot);
    if (!identity) {
      skippedFiles++;
      continue;
    }
    const entry = { ...identity, stateFile, lastRun: null, prCount: null, issueCount: null };
    if (snapshot) {
      entry.prCount = Object.keys(snapshot.pr).length;
      entry.issueCount = Object.keys(snapshot.issue).length;
      if (typeof snapshot.meta?.horizon === 'string') entry.lastRun = snapshot.meta.horizon;
    } else {
      entry.error = readError;
    }
    if (!entry.lastRun) {
      try {
        entry.lastRun = statSync(stateFile).mtime.toISOString();
      } catch {
        continue; // vanished mid-scan
      }
    }
    byPath.set(canonicalStateFileKey(stateFile), entry);
  }
  return skippedFiles;
}

function mergeRegistry(registryDir, byPath) {
  const { entries, skippedFiles } = readRegistry(registryDir);
  for (const registered of entries) {
    const key = canonicalStateFileKey(registered.stateFile);
    if (byPath.has(key)) continue; // the scan already saw the live snapshot
    const entry = {
      repo: registered.repo,
      monitorId: registered.monitorId,
      entities: registered.entities,
      stateFile: registered.stateFile,
      lastRun: registered.lastRun,
      prCount: null,
      issueCount: null,
    };
    let snapshot = null;
    try {
      snapshot = readSnapshot(registered.stateFile);
    } catch (err) {
      entry.error = String(err?.message ?? err);
    }
    if (snapshot) {
      entry.prCount = Object.keys(snapshot.pr).length;
      entry.issueCount = Object.keys(snapshot.issue).length;
      if (typeof snapshot.meta?.horizon === 'string') entry.lastRun = snapshot.meta.horizon;
    } else if (!entry.error) {
      // Registered but the snapshot file is gone: retired monitor or cleaned
      // state. Keep the memory of it, flagged, instead of hiding it.
      entry.stale = true;
    }
    byPath.set(key, entry);
  }
  return skippedFiles;
}

/**
 * Inventory the monitor snapshots reachable from one state directory and,
 * optionally, the run registry.
 *
 * Each entry carries the decoded identity (from the derived filename, the
 * snapshot's self-describing `meta`, or the registry entry), the last run
 * timestamp (`meta.horizon` when readable; registry `lastRun` or file mtime
 * otherwise), and the stored object counts. Unreadable snapshots keep their
 * entry with an `error` string; registered snapshots that no longer exist keep
 * theirs with `stale: true`. Files that cannot be identified are counted in
 * `skippedFiles`, never guessed at.
 *
 * A missing directory is an empty inventory, not an error; other filesystem
 * failures (permissions) throw for the caller to classify.
 *
 * @param {string} stateDir
 * @param {{ sinceMs?: number|null, now?: () => string, registryDir?: string|null }} [options]
 * @returns {{ monitors: object[], skippedFiles: number }}
 */
export function listMonitors(
  stateDir,
  { sinceMs = null, now = () => new Date().toISOString(), registryDir = null } = {},
) {
  const byPath = new Map();
  let skippedFiles = scanStateDir(stateDir, byPath);
  if (registryDir) skippedFiles += mergeRegistry(registryDir, byPath);
  const cutoff = sinceMs == null ? null : Date.parse(now()) - sinceMs;
  const monitors = [...byPath.values()].filter(
    (monitor) => cutoff == null || Date.parse(monitor.lastRun) >= cutoff,
  );
  monitors.sort(
    (a, b) => b.lastRun.localeCompare(a.lastRun) || a.stateFile.localeCompare(b.stateFile),
  );
  return { monitors, skippedFiles };
}
