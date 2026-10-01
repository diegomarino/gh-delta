import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWatchSync } from './watch-sync-parse.mjs';
import {
  identityKey,
  readWatchSet,
  shapeWatchEntry,
  sortWatchEntries,
  WATCH_SET_FILENAME,
} from './watch-entry.mjs';
import {
  acquireWatchDirLock,
  WatchDirBusyError,
  watchDirLockStateFile,
  withWatchDirLock,
  atomic,
} from './watch-lock.mjs';
import { assertLockOwned, releaseLock } from './lock.mjs';
import { readWatch } from './watch.mjs';

export { WatchDirBusyError };

function labelsEqual(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function reportIdentity(entry) {
  const identity = { entity: entry.entity, number: entry.number };
  if (entry.repo !== undefined) identity.repo = entry.repo;
  return identity;
}

function compareIdentities(a, b) {
  const ar = a.repo ?? '';
  const br = b.repo ?? '';
  if (ar === '' && br !== '') return -1;
  if (ar !== '' && br === '') return 1;
  return ar.localeCompare(br) || a.entity.localeCompare(b.entity) || a.number - b.number;
}

function sortIdentities(list) {
  return [...list].sort(compareIdentities);
}

function mergeDesired(currentEntries, desiredEntries, now) {
  const currentByKey = new Map(currentEntries.map((entry) => [identityKey(entry), entry]));
  const next = [];
  for (const desired of desiredEntries) {
    const current = currentByKey.get(identityKey(desired));
    if (!current) {
      next.push(shapeWatchEntry(desired, now()));
      continue;
    }
    if (current.until === desired.until && labelsEqual(current.labels, desired.labels)) {
      next.push(
        shapeWatchEntry(current, current.addedAt, {
          ignoredTerminalAt: current.ignoredTerminalAt,
        }),
      );
      continue;
    }
    if (current.until !== desired.until) {
      next.push(shapeWatchEntry(desired, now()));
      continue;
    }
    next.push(
      shapeWatchEntry(desired, current.addedAt, {
        ignoredTerminalAt: current.ignoredTerminalAt,
      }),
    );
  }
  return sortWatchEntries(next);
}

function diffSets(previous, next) {
  const prevByKey = new Map(previous.map((entry) => [identityKey(entry), entry]));
  const nextByKey = new Map(next.map((entry) => [identityKey(entry), entry]));
  const added = [];
  const removed = [];
  const updated = [];
  const unchanged = [];
  for (const [key, entry] of nextByKey) {
    const before = prevByKey.get(key);
    const identity = reportIdentity(entry);
    if (!before) added.push(identity);
    else if (before.until !== entry.until || !labelsEqual(before.labels, entry.labels))
      updated.push(identity);
    else unchanged.push(identity);
  }
  for (const [key, entry] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(reportIdentity(entry));
  }
  return {
    added: sortIdentities(added),
    removed: sortIdentities(removed),
    updated: sortIdentities(updated),
    unchanged: sortIdentities(unchanged),
  };
}

function requireGeneration(current, expected, message) {
  if (current.generation === expected) return current;
  const err = new Error(message);
  err.code = 'WATCH_DIR_BUSY';
  throw err;
}

export function writeManifestUnlocked(dir, { generation, entries }) {
  atomic(join(dir, WATCH_SET_FILENAME), {
    formatVersion: 1,
    generation,
    entries: sortWatchEntries(entries),
  });
}

export function syncWatch(
  dir,
  text,
  { repo, allowEmpty, now = () => new Date().toISOString() } = {},
) {
  const desired = parseWatchSync(text, { repo, allowEmpty });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const acquired = acquireWatchDirLock(dir);
  if (!acquired.ok) throw new WatchDirBusyError(`watch directory locked: ${dir}`);
  let committed = false;
  try {
    const path = join(dir, WATCH_SET_FILENAME);
    const fromManifest = existsSync(path);
    const currentEntries = fromManifest ? readWatchSet(path).entries : readWatch(dir);
    const nextEntries = mergeDesired(currentEntries, desired.entries, now);
    if (fromManifest && JSON.stringify(currentEntries) === JSON.stringify(nextEntries)) {
      return { ...diffSets(currentEntries, nextEntries), committed: false };
    }
    if (!assertLockOwned(watchDirLockStateFile(dir), acquired.token)) {
      throw new WatchDirBusyError(`watch directory lock lost: ${dir}`);
    }
    writeManifestUnlocked(dir, { generation: randomUUID(), entries: nextEntries });
    committed = true;
    return { ...diffSets(currentEntries, nextEntries), committed };
  } catch (err) {
    if (committed) err.committed = true;
    throw err;
  } finally {
    releaseLock(watchDirLockStateFile(dir), acquired.token);
  }
}

export function readWatchGenerationUnlocked(dir) {
  const path = join(dir, WATCH_SET_FILENAME);
  if (existsSync(path)) {
    const set = readWatchSet(path);
    return { entries: set.entries, generation: set.generation };
  }
  return { entries: readWatch(dir), generation: null };
}

export function readWatchGeneration(dir) {
  return withWatchDirLock(dir, () => readWatchGenerationUnlocked(dir));
}

export function assertWatchGeneration(dir, generation) {
  return withWatchDirLock(dir, () =>
    requireGeneration(
      readWatchGenerationUnlocked(dir),
      generation,
      'watch membership changed before publication',
    ),
  );
}

export function removeManifestEntries(dir, identities, expectedGeneration) {
  return withWatchDirLock(dir, () => {
    const current = requireGeneration(
      readWatchGenerationUnlocked(dir),
      expectedGeneration,
      'watch membership changed before cleanup',
    );
    const drop = new Set(identities.map(identityKey));
    const entries = current.entries.filter((entry) => !drop.has(identityKey(entry)));
    if (entries.length === current.entries.length) return current.generation;
    const generation = randomUUID();
    writeManifestUnlocked(dir, { generation, entries });
    return generation;
  });
}

export function markManifestTerminalIgnoredUnlocked(
  dir,
  identities,
  ignoredAt,
  expectedGeneration,
) {
  const current = requireGeneration(
    readWatchGenerationUnlocked(dir),
    expectedGeneration,
    'watch membership changed before terminal mark',
  );
  const want = new Set(identities.map(identityKey));
  let changed = false;
  const entries = current.entries.map((entry) => {
    if (!want.has(identityKey(entry)) || entry.ignoredTerminalAt !== undefined) return entry;
    changed = true;
    return { ...entry, ignoredTerminalAt: ignoredAt };
  });
  if (!changed) return current.generation;
  const generation = randomUUID();
  writeManifestUnlocked(dir, { generation, entries });
  return generation;
}

export function markManifestTerminalIgnored(dir, identities, ignoredAt, expectedGeneration) {
  return withWatchDirLock(dir, () =>
    markManifestTerminalIgnoredUnlocked(dir, identities, ignoredAt, expectedGeneration),
  );
}
