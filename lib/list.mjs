// Read-only monitor inventory over a state directory. Decodes derived snapshot
// filenames back into (repo, monitorId, entities), never contacts GitHub, and
// never writes: a corrupt snapshot becomes an entry with `error`, not a failure.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSnapshot } from './snapshot.mjs';

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

/**
 * Inventory the derived monitor snapshots in one state directory.
 *
 * Each entry carries the decoded identity, the last run timestamp
 * (`meta.horizon` when readable, file mtime otherwise), and the stored object
 * counts. Unreadable snapshots keep their entry with an `error` string so
 * operators can spot broken state. Files that do not look like derived
 * snapshots are counted in `skippedFiles`, never guessed at.
 *
 * A missing directory is an empty inventory, not an error; other filesystem
 * failures (permissions) throw for the caller to classify.
 *
 * @param {string} stateDir
 * @param {{ sinceMs?: number|null, now?: () => string }} [options]
 * @returns {{ monitors: object[], skippedFiles: number }}
 */
export function listMonitors(
  stateDir,
  { sinceMs = null, now = () => new Date().toISOString() } = {},
) {
  let names;
  try {
    names = readdirSync(stateDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { monitors: [], skippedFiles: 0 };
    throw err;
  }
  const cutoff = sinceMs == null ? null : Date.parse(now()) - sinceMs;
  const monitors = [];
  let skippedFiles = 0;
  for (const name of names) {
    const identity = parseSnapshotFilename(name);
    if (!identity) {
      skippedFiles++;
      continue;
    }
    const stateFile = join(stateDir, name);
    let mtime;
    try {
      mtime = statSync(stateFile).mtime.toISOString();
    } catch {
      continue; // file vanished mid-scan
    }
    const entry = { ...identity, stateFile, lastRun: mtime, prCount: null, issueCount: null };
    try {
      const snapshot = readSnapshot(stateFile);
      if (snapshot == null) continue; // vanished between readdir and read
      entry.prCount = Object.keys(snapshot.pr).length;
      entry.issueCount = Object.keys(snapshot.issue).length;
      if (typeof snapshot.meta?.horizon === 'string') entry.lastRun = snapshot.meta.horizon;
    } catch (err) {
      entry.error = String(err?.message ?? err);
    }
    if (cutoff != null && Date.parse(entry.lastRun) < cutoff) continue;
    monitors.push(entry);
  }
  monitors.sort(
    (a, b) => b.lastRun.localeCompare(a.lastRun) || a.stateFile.localeCompare(b.stateFile),
  );
  return { monitors, skippedFiles };
}
