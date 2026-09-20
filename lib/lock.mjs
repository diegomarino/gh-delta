// One-writer-per-(repo, monitorId, entities) lock, guarding the snapshot
// read-fetch-write window against a lost update: two processes sharing a
// state file both read the old snapshot, both fetch GitHub, both write, and
// one process's observations silently vanish (last-writer-wins). Snapshot
// writes (lib/snapshot.mjs writeSnapshotAtomic) are already atomic -- that
// only prevents partial JSON, not this lost-update race across two
// independent writers. The lock makes the race a visible, transient `busy`
// error instead of silent data loss. See docs/contract.md "Lock Semantics"
// for the full protocol writeup.
//
// Protocol, in brief:
//   1. acquireLock: fs.openSync(path, 'wx') -- atomic create, portable, no
//      flock. EEXIST means a lock file exists (live, expired, or corrupt);
//      inspect it.
//   2. Stealing an expired or unreadable-and-old lock is done by
//      fs.renameSync, never read-verify-delete: rename is atomic, so of two
//      simultaneous thieves exactly one succeeds and the loser gets ENOENT
//      here and reports `busy` (the winner proceeds).
//   3. releaseLock unlinks only if the on-disk token still matches ours, so
//      a slow-but-alive holder whose lock was stolen out from under it can
//      never delete a lock that now belongs to someone else.
//   4. assertLockOwned is the pre-write fence: call it immediately before
//      writeSnapshotAtomic and abort with `busy` (writing nothing) if the
//      token no longer matches. This narrows, but cannot close, the
//      lost-update window to the scheduler gap between that read and the
//      snapshot rename -- two syscalls on two files are never one atomic
//      operation.
//
// No lease renewal: lib/gh.mjs fetches through execFileSync, which blocks
// the single JS thread, so a setInterval renewal timer provably cannot fire
// during a fetch. expiresAt is instead computed once, at acquire time, as
// acquiredAt + numberOfFetches * ghTimeoutMs + LOCK_EXPIRY_SLACK_MS -- a
// ceiling long enough to cover every GitHub fetch this run will make.
import {
  openSync as nodeOpenSync,
  writeSync as nodeWriteSync,
  closeSync as nodeCloseSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  statSync as nodeStatSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

// Added on top of the sum of this run's fetch timeouts when computing
// expiresAt. Covers (a) scheduling jitter between the acquire timestamp and
// the first fetch actually starting, (b) the detect + snapshot-write phase
// after the last fetch completes and before the fence check, and (c) minor
// clock skew. 5s is generous relative to a snapshot write (milliseconds) and
// small relative to typical --gh-timeout-ms values (tens of seconds), so it
// does not meaningfully extend how long a genuinely dead holder blocks a new
// acquirer.
export const LOCK_EXPIRY_SLACK_MS = 5000;

function safeHostname() {
  try {
    return osHostname();
  } catch {
    return 'unknown-host'; // containers without a resolvable hostname
  }
}

function defaultFs() {
  return {
    openSync: nodeOpenSync,
    writeSync: nodeWriteSync,
    closeSync: nodeCloseSync,
    readFileSync: nodeReadFileSync,
    renameSync: nodeRenameSync,
    unlinkSync: nodeUnlinkSync,
    statSync: nodeStatSync,
  };
}

/**
 * The lock path for a given state file. Deleting this file by hand is always
 * safe: a live holder simply loses its fence check and reports `busy` on its
 * next write attempt (see assertLockOwned), it never corrupts the snapshot.
 */
export function lockPath(stateFile) {
  return `${stateFile}.lock`;
}

function createLockFile(fs, path, contents) {
  const fd = fs.openSync(path, 'wx');
  try {
    fs.writeSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

// Parse a lock file's contents into its record, or throw. Used by both the
// acquire path (to decide expired vs held) and release/fence checks.
function readLockRecord(fs, path) {
  const record = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (
    typeof record?.token !== 'string' ||
    typeof record?.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    throw new Error(`lock record at ${path} is missing token/expiresAt`);
  }
  return record;
}

/**
 * Acquire the lock at `<stateFile>.lock`.
 *
 * @param {string} stateFile
 * @param {{
 *   numberOfFetches: number,
 *   ghTimeoutMs: number,
 *   staleMs: number,
 *   fs?: object,
 *   now?: () => number,
 *   pid?: number,
 *   host?: string,
 * }} opts
 * @returns {{ok: true, token: string, stolen?: boolean, warning?: string} | {ok: false, reason: string}}
 */
export function acquireLock(
  stateFile,
  {
    numberOfFetches,
    ghTimeoutMs,
    staleMs,
    fs = defaultFs(),
    now = () => Date.now(),
    pid = process.pid,
    host = safeHostname(),
  } = {},
) {
  const path = lockPath(stateFile);
  const token = randomUUID();
  const acquiredAtMs = now();
  const expiresAtMs = acquiredAtMs + numberOfFetches * ghTimeoutMs + LOCK_EXPIRY_SLACK_MS;
  const contents = JSON.stringify({
    token,
    pid,
    host,
    acquiredAt: new Date(acquiredAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });

  try {
    createLockFile(fs, path, contents);
    return { ok: true, token };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  // A lock file exists: decide whether it names a live holder, an expired
  // one, or is unreadable (a kill mid-write can truncate the file).
  let record;
  let unreadable = false;
  try {
    record = readLockRecord(fs, path);
  } catch {
    unreadable = true;
  }

  if (!unreadable) {
    if (Date.parse(record.expiresAt) > acquiredAtMs) {
      return { ok: false, reason: 'held', holder: record };
    }
    // Expired: falls through to the steal-by-rename below. This is routine
    // operation, not an anomaly, so it carries no warning.
  } else {
    // Never deadlock on a corrupt lock, but never treat a possibly-live
    // holder as abandoned either: only steal an unreadable lock once it is
    // older than the generous --lock-stale-ms ceiling.
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path).mtimeMs;
    } catch (err) {
      // Lock vanished between our EEXIST and this stat -- another process
      // released or stole it in the gap. Report busy; the next tick retries.
      if (err?.code === 'ENOENT') return { ok: false, reason: 'held' };
      throw err;
    }
    if (acquiredAtMs - mtimeMs <= staleMs) {
      return { ok: false, reason: 'unreadable-recent' };
    }
    // Older than the ceiling: presumed abandoned, steal below with a warning.
  }

  // Steal by rename, never read-verify-delete: rename is atomic, so of two
  // simultaneous thieves exactly one succeeds; the other gets ENOENT here.
  const staleName = `${path}.stale-${token}`;
  try {
    fs.renameSync(path, staleName);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'lost-steal-race' };
    throw err;
  }
  try {
    fs.unlinkSync(staleName);
  } catch {
    // Best-effort cleanup of the renamed-away stale lock; irrelevant to the
    // steal, which already succeeded once the rename above returned.
  }

  try {
    createLockFile(fs, path, contents);
  } catch (err) {
    // Vanishingly unlikely: something else created a fresh lock in the gap
    // between our rename and our create. Report busy; the next tick retries.
    if (err?.code === 'EEXIST') return { ok: false, reason: 'held' };
    throw err;
  }

  return {
    ok: true,
    token,
    stolen: true,
    ...(unreadable
      ? { warning: `stole unreadable lock at ${path} (mtime older than --lock-stale-ms)` }
      : {}),
  };
}

/**
 * Release the lock, but only if the on-disk token still matches ours.
 *
 * This is the fix for the original bug this lock exists to close: a
 * slow-but-alive holder whose lock has since expired and been stolen must
 * never delete a lock that now belongs to someone else.
 */
export function releaseLock(stateFile, token, { fs = defaultFs() } = {}) {
  const path = lockPath(stateFile);
  let record;
  try {
    record = readLockRecord(fs, path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, released: false };
    return { ok: false, released: false, reason: 'unreadable' };
  }
  if (record.token !== token) return { ok: false, released: false, reason: 'not-owner' };
  try {
    fs.unlinkSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, released: false };
    throw err;
  }
  return { ok: true, released: true };
}

/**
 * The pre-write fence. Call immediately before writeSnapshotAtomic: `true`
 * only if the lock file on disk still names our token. `false` means
 * ownership was lost during the fetch -- the caller must fail with `busy`
 * and write nothing.
 *
 * Honesty note: this check and the snapshot rename are two syscalls on two
 * files, not one atomic operation. The OS can preempt between them, so this
 * narrows the lost-update window from the whole fetch duration down to that
 * scheduler gap -- it does not eliminate the race.
 */
export function assertLockOwned(stateFile, token, { fs = defaultFs() } = {}) {
  const path = lockPath(stateFile);
  try {
    return readLockRecord(fs, path).token === token;
  } catch {
    return false;
  }
}
