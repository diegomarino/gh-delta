// Run registry: one tiny breadcrumb file per monitor in a fixed per-user
// location, written after each successful detector run so `gh-delta list` can
// discover every local monitor regardless of where its snapshot lives. The
// registry is an index, never detector state: deleting it is always safe (it
// rebuilds as monitors tick) and losing it never causes false deltas or
// re-baselines. Writes are best-effort at the call site and never change the
// detector exit code.
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';

export const REGISTRY_VERSION = 1;

/**
 * Per-user registry directory: `$GH_DELTA_REGISTRY_DIR` when set, otherwise
 * `$XDG_STATE_HOME/gh-delta/registry` falling back to
 * `~/.local/state/gh-delta/registry`. Durable on purpose — unlike the temp-dir
 * snapshot default, a reboot must not erase the inventory.
 */
export function defaultRegistryDir({ env = process.env, homedir = osHomedir } = {}) {
  if (env.GH_DELTA_REGISTRY_DIR) return env.GH_DELTA_REGISTRY_DIR;
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateHome, 'gh-delta', 'registry');
}

/**
 * Canonical identity key for a snapshot path. Case-folded on Windows: its
 * filesystems are case-insensitive, so `C:\State` and `c:\state` are the same
 * monitor and must hash to the same registry entry and dedupe key.
 */
export function canonicalStateFileKey(stateFile, platform = process.platform) {
  const resolved = resolve(stateFile);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Registry entry path for one monitor. The key is a hash of the canonical
 * snapshot path, so re-registering the same monitor always overwrites its own
 * entry (idempotent, last-writer-wins) and concurrent monitors never share a
 * file — no locks needed.
 */
export function registryEntryPath(registryDir, stateFile, platform = process.platform) {
  const key = createHash('sha256')
    .update(canonicalStateFileKey(stateFile, platform))
    .digest('hex')
    .slice(0, 16);
  return join(registryDir, `${key}.json`);
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    renameSync(tmp, path); // atomic on POSIX within one filesystem
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; the original rename error is the one that matters
    }
    throw err;
  }
}

/**
 * Record one monitor run in the registry. Callers treat this as best-effort:
 * wrap it in try/catch and never let a registry failure change the run result.
 *
 * @param {{ repo: string, monitorId: string, entities: string[], stateFile: string, lastRun: string, env?: object, homedir?: () => string }} run
 * @returns {{ path: string, entry: object }} where the entry landed
 */
export function registerMonitor({ repo, monitorId, entities, stateFile, lastRun, env, homedir }) {
  const dir = defaultRegistryDir({ env: env ?? process.env, homedir: homedir ?? osHomedir });
  const entry = {
    registryVersion: REGISTRY_VERSION,
    repo,
    monitorId,
    entities,
    stateFile: resolve(stateFile),
    lastRun,
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = registryEntryPath(dir, stateFile);
  writeJsonAtomic(path, entry);
  return { path, entry };
}

function isValidEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.repo === 'string' &&
    typeof entry.monitorId === 'string' &&
    Array.isArray(entry.entities) &&
    typeof entry.stateFile === 'string' &&
    typeof entry.lastRun === 'string'
  );
}

/**
 * Read every registry entry. A missing directory is an empty registry; a
 * corrupt or foreign file is counted in `skippedFiles`, never guessed at.
 *
 * @param {string} registryDir
 * @returns {{ entries: object[], skippedFiles: number }}
 */
export function readRegistry(registryDir) {
  let names;
  try {
    names = readdirSync(registryDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], skippedFiles: 0 };
    throw err;
  }
  const entries = [];
  let skippedFiles = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      skippedFiles++;
      continue;
    }
    try {
      const entry = JSON.parse(readFileSync(join(registryDir, name), 'utf8'));
      if (!isValidEntry(entry)) {
        skippedFiles++;
        continue;
      }
      entries.push(entry);
    } catch {
      skippedFiles++;
    }
  }
  return { entries, skippedFiles };
}
