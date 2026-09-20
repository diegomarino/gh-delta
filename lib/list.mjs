// Read-only monitor inventory. Discovers monitors two ways — scanning a state
// directory (derived filenames, or self-describing snapshot meta for arbitrary
// names) and reading the run registry — merges them by snapshot path, never
// contacts GitHub, and never writes: a corrupt snapshot becomes an entry with
// `error`, a registered snapshot that vanished becomes an entry with `stale`.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSnapshot } from './snapshot.mjs';
import { canonicalStateFileKey, readRegistry } from './registry.mjs';
import { parseDuration } from './duration.mjs';
import { readWatch, watchDirPath } from './watch.mjs';

// Derived snapshot filenames never contain a literal `_` inside a segment
// (snapshotPath encodes `_` as %5F), so `__` is an unambiguous separator.
const SNAPSHOT_FILENAME = /^repo-([^_]+)__monitor-([^_]+)__(?:watch-pr|([^_]+))\.json$/;

/**
 * Parse a `--since` duration like `90s`, `15m`, `24h`, or `7d` into milliseconds.
 *
 * Thin wrapper over the shared duration grammar in duration.mjs, kept here
 * (and exported) because it is part of this module's established surface —
 * `lib/cli.mjs` imports it by name.
 *
 * @param {string|unknown} raw
 * @returns {{ ms: number } | { error: string }}
 */
export function parseSince(raw) {
  return parseDuration(raw, { flag: '--since' });
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
    const economical = filename.endsWith('__watch-pr.json');
    return {
      repo: decodeURIComponent(match[1]),
      monitorId: decodeURIComponent(match[2]),
      entities: economical ? ['pr'] : match[3].split('-'),
      ...(economical ? { scope: 'watch-pr' } : {}),
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
    return {
      repo: meta.repo,
      monitorId: meta.monitorId,
      entities: meta.entities,
      ...(meta.scope === 'watch-pr' ? { scope: 'watch-pr' } : {}),
    };
  }
  return null;
}

function observationTimestamp(entry, fallback) {
  return entry.lastOkAt ?? entry.lastRun ?? fallback ?? null;
}

function newerTimestamp(first, second) {
  if (!first) return second ?? null;
  if (!second) return first;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function addDiagnostics(entry, now, fallback) {
  const observedAt = observationTimestamp(entry, fallback);
  entry.lastAttemptAt ??= null;
  entry.lastOkAt ??= observedAt;
  entry.lastError ??= null;
  entry.observationAgeMs = observedAt
    ? Math.max(0, Date.parse(now) - Date.parse(observedAt))
    : null;
  if (entry.error) entry.snapshotStatus = 'corrupt';
  else if (entry.snapshotPresent || entry.snapshotStatus === 'present')
    entry.snapshotStatus = 'present';
  else if (observedAt) {
    entry.snapshotStatus = 'expected-missing';
    entry.stale = true;
  } else entry.snapshotStatus = 'not-yet-created';
  delete entry.snapshotPresent;
  return observedAt;
}

function addWatchCount(entry, stateDir) {
  const dir =
    entry.watchDir ??
    watchDirPath(
      entry.repo,
      entry.monitorId,
      entry.registryEntry ? dirname(entry.stateFile) : stateDir,
    );
  try {
    entry.watched = readWatch(dir).length;
  } catch (err) {
    entry.watched = null;
    entry.watchError = String(err?.message ?? err);
  }
}

function scanStateDir(stateDir, byPath, now) {
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
    const entry = {
      registryEntry: true,
      ...identity,
      stateFile,
      lastRun: null,
      prCount: null,
      issueCount: null,
      snapshotPresent: true,
    };
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
    addDiagnostics(entry, now, entry.lastRun);
    byPath.set(canonicalStateFileKey(stateFile), entry);
  }
  return skippedFiles;
}

function mergeRegistry(registryDir, byPath, now) {
  const { entries, skippedFiles } = readRegistry(registryDir);
  for (const registered of entries) {
    const key = canonicalStateFileKey(registered.stateFile);
    if (byPath.has(key)) {
      const scanned = byPath.get(key);
      Object.assign(scanned, {
        lastAttemptAt: registered.lastAttemptAt ?? null,
        lastOkAt: newerTimestamp(
          registered.lastOkAt ?? registered.lastRun,
          scanned.lastOkAt ?? scanned.lastRun,
        ),
        lastError: registered.lastError ?? null,
        ...(registered.watchDir ? { watchDir: registered.watchDir } : {}),
        ...(registered.scope === 'watch-pr' ? { scope: 'watch-pr' } : {}),
      });
      addDiagnostics(scanned, now, scanned.lastRun);
      continue;
    }
    const entry = {
      repo: registered.repo,
      monitorId: registered.monitorId,
      entities: registered.entities,
      stateFile: registered.stateFile,
      lastRun: registered.lastRun,
      lastAttemptAt: registered.lastAttemptAt ?? null,
      lastOkAt: registered.lastOkAt ?? registered.lastRun ?? null,
      lastError: registered.lastError ?? null,
      ...(registered.watchDir ? { watchDir: registered.watchDir } : {}),
      ...(registered.scope === 'watch-pr' ? { scope: 'watch-pr' } : {}),
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
      entry.snapshotPresent = true;
      entry.prCount = Object.keys(snapshot.pr).length;
      entry.issueCount = Object.keys(snapshot.issue).length;
      if (typeof snapshot.meta?.horizon === 'string') {
        entry.lastRun = snapshot.meta.horizon;
        entry.lastOkAt = newerTimestamp(entry.lastOkAt, snapshot.meta.horizon);
      }
    }
    addDiagnostics(entry, now, entry.lastRun);
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
  const at = now();
  let skippedFiles = scanStateDir(stateDir, byPath, at);
  if (registryDir) skippedFiles += mergeRegistry(registryDir, byPath, at);
  const cutoff = sinceMs == null ? null : Date.parse(now()) - sinceMs;
  const monitors = [...byPath.values()].filter(
    (monitor) =>
      cutoff == null || (monitor.lastOkAt != null && Date.parse(monitor.lastOkAt) >= cutoff),
  );
  monitors.sort(
    (a, b) =>
      (b.lastRun ?? '').localeCompare(a.lastRun ?? '') || a.stateFile.localeCompare(b.stateFile),
  );
  for (const monitor of monitors) addWatchCount(monitor, stateDir);
  return { monitors, skippedFiles };
}
