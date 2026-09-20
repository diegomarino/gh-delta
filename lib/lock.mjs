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
//   1. acquireLock: publish a brand-new lock file exclusively (EEXIST if one
//      is already there; inspect it -- live, expired, or corrupt).
//   2. Stealing an expired or unreadable-and-old lock is done by
//      fs.renameSync to a throwaway name, never read-verify-delete: rename is
//      atomic, so of two simultaneous thieves exactly one succeeds and the
//      loser gets ENOENT here and reports `busy`. The winner then re-reads
//      the renamed-away file and checks it is still the same expired/corrupt
//      lock it decided to steal -- if a third party's live lock ended up
//      renamed instead (two thieves reading the same expired lock, the first
//      already replacing it before the second's rename lands), the winner
//      puts it back at `path` and reports `busy` instead of proceeding.
//   3. releaseLock renames the lock to a throwaway name first, then checks
//      the on-disk token still matches ours before unlinking it; a mismatch
//      means it was stolen and replaced, so the renamed file is put back and
//      left alone. This is what makes stealing safe: a slow-but-alive holder
//      whose lock was stolen out from under it can never delete a lock that
//      now belongs to someone else.
//   4. assertLockOwned is the pre-write fence: call it immediately before
//      writeSnapshotAtomic and abort with `busy` (writing nothing) if the
//      token no longer matches. snapshot.mjs's writeSnapshotAtomic also
//      accepts a `verifyBeforeCommit` callback invoked right before its final
//      rename, so the same check runs again immediately before the syscall
//      that publishes the snapshot. This narrows, but cannot close, the
//      lost-update window to that single remaining syscall gap -- two
//      syscalls on two files are never one atomic operation.
//
// No *timer-driven* lease renewal: lib/gh.mjs fetches through execFileSync,
// which blocks the single JS thread, so a setInterval renewal timer provably
// cannot fire during a fetch. That does not rule out renewal altogether --
// lib/gh.mjs's pagination calls back into ordinary synchronous control flow
// after each page completes, and extendLockDeadline below is invoked from
// exactly that callback. expiresAt therefore starts small at acquire time
// (acquiredAt + ghTimeoutMs + LOCK_EXPIRY_SLACK_MS, enough to cover one `gh`
// call) and is pushed forward by one ghTimeoutMs + slack per completed page.
// A hung fetch simply stops completing pages, stops extending, and expires
// on schedule.
import {
  openSync as nodeOpenSync,
  writeSync as nodeWriteSync,
  closeSync as nodeCloseSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  statSync as nodeStatSync,
  linkSync as nodeLinkSync,
  mkdirSync as nodeMkdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { dirname } from 'node:path';

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
    linkSync: nodeLinkSync,
    mkdirSync: nodeMkdirSync,
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

// Write `contents` to a throwaway, uniquely-named temp file first, then
// publish it. Writing straight to the final path with open('wx')+write, as
// this used to, makes the (empty) directory entry visible the instant open()
// returns -- a concurrent reader between that open and the write landing
// would see a torn (empty) lock file. Writing the temp file first means the
// content is always complete before it becomes visible at `path`.
function writeTempLockFile(fs, path, contents) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

// Publish a brand-new lock file at `path`, atomically and exclusively: fails
// with EEXIST if `path` is already occupied. Used for the very first
// acquire and for recreating the lock right after a steal-rename -- both
// cases where two racing callers must never both succeed. `linkSync` (unlike
// `renameSync`) preserves that EEXIST guarantee while still publishing
// already-complete content, so callers never observe a torn write.
// Hard links are not universal. NTFS supports them, but FAT32/exFAT volumes,
// several network filesystems, and some container bind mounts reject linkSync
// with EPERM/ENOSYS/EOPNOTSUPP. Those are all places writeSnapshotAtomic works
// fine (it only needs rename), so failing the lock there would make gh-delta
// unusable on a volume where the snapshot itself is healthy.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV']);

function createLockFile(fs, path, contents) {
  const tmp = writeTempLockFile(fs, path, contents);
  try {
    fs.linkSync(tmp, path);
  } catch (err) {
    if (!LINK_UNSUPPORTED.has(err?.code)) throw err;
    // Fallback: exclusive create straight at the final path. This reopens the
    // brief window where the directory entry exists while still empty, but a
    // reader landing there sees an unreadable lock, which the corrupt-lock
    // path already handles as a transient `busy` rather than a steal. Losing
    // torn-read protection on an exotic filesystem beats not locking at all.
    const fd = fs.openSync(path, 'wx');
    try {
      fs.writeSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the temp file; irrelevant once the lock above
      // already published (or failed for a reason the caller handles/throws)
    }
  }
}

// Overwrite an *existing* lock file's content atomically. No exclusivity is
// needed here -- the caller has already verified it owns the lock by token --
// only that a concurrent reader never sees a half-written update, so this is
// a plain temp-write + rename (rename is an atomic replace on POSIX within
// one filesystem).
function overwriteLockFile(fs, path, contents) {
  const tmp = writeTempLockFile(fs, path, contents);
  fs.renameSync(tmp, path);
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

// True when the file now at `renamedPath` (just renamed away from the live
// lock path during a steal) is still the same lock the caller decided to
// steal, not a live lock some other contender created/renewed in the gap
// between the caller reading the original and the rename landing.
//
// `expected` is `{ token }` for a readable-and-expired lock, or `null` for
// an unreadable/corrupt one -- there is no token to compare in that case, but
// a live lock is always well-formed JSON, so successfully parsing a valid
// record here means the file is not the corrupt one the caller inspected.
function isSameStolenLock(fs, renamedPath, expected) {
  let renamedRecord;
  try {
    renamedRecord = readLockRecord(fs, renamedPath);
  } catch {
    return expected === null;
  }
  return expected !== null && renamedRecord.token === expected.token;
}

/**
 * Push a held lock's `expiresAt` forward after a unit of progress (one
 * gh.mjs pagination page completing). Called from an `onProgress` hook
 * between pages -- ordinary synchronous control flow, not a timer, so it
 * runs even though `execFileSync` blocks the JS thread during each page.
 *
 * Refuses to extend a lock that is not ours: if the on-disk token does not
 * match `token`, this is a no-op. It never writes on behalf of a lock it
 * does not own -- the pre-write fence (`assertLockOwned` /
 * `writeSnapshotAtomic`'s `verifyBeforeCommit`) is what catches the loss.
 *
 * @param {string} stateFile
 * @param {string} token
 * @param {{ghTimeoutMs: number, fs?: object, now?: () => number}} opts
 * @returns {{ok: boolean}}
 */
export function extendLockDeadline(
  stateFile,
  token,
  { ghTimeoutMs, fs = defaultFs(), now = () => Date.now() } = {},
) {
  const path = lockPath(stateFile);
  let record;
  try {
    record = readLockRecord(fs, path);
  } catch {
    return { ok: false }; // gone or unreadable; nothing safe to extend
  }
  if (record.token !== token) return { ok: false }; // not ours -- never touch it
  const newExpiresAtMs = now() + ghTimeoutMs + LOCK_EXPIRY_SLACK_MS;
  const updated = { ...record, expiresAt: new Date(newExpiresAtMs).toISOString() };
  overwriteLockFile(fs, path, JSON.stringify(updated));
  return { ok: true };
}

/**
 * Acquire the lock at `<stateFile>.lock`.
 *
 * The initial lease is deliberately short -- one `ghTimeoutMs` plus slack,
 * enough to cover a single `gh` call -- not sized for the whole run's worst
 * case. A paginated fetch (lib/gh.mjs) extends it per completed page via
 * `extendLockDeadline`; a run that stops making progress simply expires on
 * schedule instead of squatting on the lock for a ceiling wide enough to
 * cover 40 pages that never happen.
 *
 * Also ensures the state file's parent directory exists (recursive mkdir)
 * before attempting to create the lock file there. `writeSnapshotAtomic`
 * used to create it lazily at snapshot-write time, but the lock now runs
 * first, so an explicit `--state-dir`/`--state-file` whose directory doesn't
 * exist yet would otherwise fail here with `ENOENT` on a first run.
 *
 * @param {string} stateFile
 * @param {{
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
    ghTimeoutMs,
    staleMs,
    fs = defaultFs(),
    now = () => Date.now(),
    pid = process.pid,
    host = safeHostname(),
  } = {},
) {
  const path = lockPath(stateFile);
  fs.mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const acquiredAtMs = now();
  const expiresAtMs = acquiredAtMs + ghTimeoutMs + LOCK_EXPIRY_SLACK_MS;
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

  // Rename succeeding only proves *some* file was renamed away -- not that it
  // is the same expired/corrupt lock this call inspected above. Two
  // contenders can both read the same expired lock; the first renames it away
  // and creates its own fresh one, and the second's rename (still targeting
  // the original path) then captures that FRESH, unexpired lock instead. Only
  // proceed once the renamed content is verified to be the one we intended to
  // steal.
  const expected = unreadable ? null : { token: record.token };
  if (!isSameStolenLock(fs, staleName, expected)) {
    // We captured a live lock that does not belong to us. Put it back and
    // report busy -- never fall through to creating a competing lock at
    // `path`, and never leave the true owner's lock stranded under staleName.
    try {
      fs.renameSync(staleName, path);
    } catch {
      // If even the restore fails (e.g. something else already recreated
      // `path`), there is nothing safer left to do than report busy; we must
      // not create a second lock ourselves.
    }
    return { ok: false, reason: 'stole-live-lock' };
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
 *
 * The ownership check and the delete must not be two independent operations
 * against the live path: a read-then-unlink sequence lets a steal land in
 * between (read our own token as still current, get stolen, then unlink the
 * new owner's lock). Instead, rename the lock to a private throwaway path
 * first -- one filesystem object, exactly one owner -- and verify *that*
 * before deleting it. If it is not ours, the rename is undone and the file is
 * left exactly as found.
 */
export function releaseLock(stateFile, token, { fs = defaultFs() } = {}) {
  const path = lockPath(stateFile);
  const takenName = `${path}.release-${randomUUID()}`;
  try {
    fs.renameSync(path, takenName);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, released: false };
    throw err;
  }

  let record;
  try {
    record = readLockRecord(fs, takenName);
  } catch {
    // Corrupt content under our own rename target -- restore it untouched
    // rather than silently discarding a lock that might belong to someone
    // else (or itself have raced with a steal).
    try {
      fs.renameSync(takenName, path);
    } catch {
      // Nothing safer left to do; report failure either way.
    }
    return { ok: false, released: false, reason: 'unreadable' };
  }

  if (record.token !== token) {
    // We renamed away a lock that is not ours -- it was stolen and replaced
    // between our last ownership check and this release call. Put it back
    // for its real owner and leave it alone.
    try {
      fs.renameSync(takenName, path);
    } catch {
      // Nothing safer left to do; report failure either way.
    }
    return { ok: false, released: false, reason: 'not-owner' };
  }

  fs.unlinkSync(takenName);
  return { ok: true, released: true };
}

/**
 * The pre-write fence. `true` only if the lock file on disk still names our
 * token. `false` means ownership was lost during the fetch -- the caller
 * must fail with `busy` and write nothing.
 *
 * The CLI calls this twice: once here, immediately after fetching and before
 * doing any detection/serialization work (cheap to fail early), and again as
 * `writeSnapshotAtomic`'s `verifyBeforeCommit` callback, which runs
 * immediately before that function's final `renameSync`. That second call is
 * the one that actually narrows the residual race: with it, the gap between
 * "ownership verified" and "snapshot published" is a single syscall
 * (`renameSync`), not the JSON-serialize-plus-temp-write window that used to
 * sit between the fence and the commit.
 *
 * Honesty note: even that single syscall is not the check itself -- the
 * verify-token read and the snapshot rename remain two syscalls against two
 * different files, not one atomic operation. The OS can still preempt
 * between them. This narrows the lost-update window to that one remaining
 * scheduler gap; it does not eliminate the race. No POSIX (or Windows)
 * filesystem primitive gives two independent files a compare-and-swap.
 */
export function assertLockOwned(stateFile, token, { fs = defaultFs() } = {}) {
  const path = lockPath(stateFile);
  try {
    return readLockRecord(fs, path).token === token;
  } catch {
    return false;
  }
}
