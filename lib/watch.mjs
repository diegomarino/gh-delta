// Local, monitor-private watch-list persistence.  This module deliberately has
// no GitHub dependency: callers validate/read it before a detector fetch.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';
import { validateRepo } from './args.mjs';

const ITEM = /^(pr|issue):(\d+)$/;

export function watchDirPath(repo, monitorId, stateDir) {
  return join(stateDir, `watch-${encodeURIComponent(repo)}__${encodeURIComponent(monitorId)}.d`);
}

export function parseWatchItem(raw) {
  const match = ITEM.exec(String(raw));
  const number = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(number) || number < 1)
    throw new Error(
      `watch item must be pr:<positive number> or issue:<positive number>; got "${raw}"`,
    );
  return { entity: match[1], number };
}

export function watchFilename(entry) {
  return entry.repo
    ? `repo-${encodeURIComponent(entry.repo)}__${entry.entity}-${entry.number}.json`
    : `${entry.entity}-${entry.number}.json`;
}
// Canonical watch entry shape: `{entity, number, until, addedAt}`, plus two
// OPTIONAL fields, `repo` (scoping) and `ignoredTerminalAt` (see
// markTerminalIgnored below). The key-count check stays exact -- an unknown
// extra key is rejected, not silently tolerated -- so "canonical" keeps
// meaning something; only the SET of allowed optional keys grew.
//
// An entry written before `ignoredTerminalAt` existed simply lacks the key.
// That is deliberately treated as valid, not as a shape to reject or
// migrate: unlike a snapshot or delta log (which the project's "no
// migration" stance applies to), a watch entry is cheap, disposable
// operator state a person creates with `watch add` -- forcing everyone to
// recreate their watch list on upgrade would be pure friction for a field
// whose absence has an exact, correct meaning ("no terminal transition has
// ever been ignored for this entry yet").
function valid(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hasRepo = entry.repo !== undefined;
  const hasIgnoredTerminalAt = entry.ignoredTerminalAt !== undefined;
  const expectedKeys = 4 + (hasRepo ? 1 : 0) + (hasIgnoredTerminalAt ? 1 : 0);
  return (
    ['pr', 'issue'].includes(entry.entity) &&
    Number.isSafeInteger(entry.number) &&
    entry.number > 0 &&
    typeof entry.addedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.addedAt)) &&
    (entry.until === 'closed' || (entry.entity === 'pr' && entry.until === 'merged')) &&
    (!hasRepo ||
      (typeof entry.repo === 'string' &&
        validateRepo(entry.repo).ok &&
        validateRepo(entry.repo).repo === entry.repo)) &&
    (!hasIgnoredTerminalAt ||
      (typeof entry.ignoredTerminalAt === 'string' &&
        !Number.isNaN(Date.parse(entry.ignoredTerminalAt)))) &&
    Object.keys(entry).length === expectedKeys
  );
}
function atomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}
function locked(path, fn) {
  const acquired = acquireLock(path, { ghTimeoutMs: 1000, staleMs: 30000 });
  if (!acquired.ok) throw new Error(`watch entry locked: ${path}`);
  try {
    return fn();
  } finally {
    releaseLock(path, acquired.token);
  }
}

export function readWatch(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  const seen = new Set();
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new Error(`invalid watch entry ${name}`);
    }
    if (!valid(entry)) throw new Error(`invalid watch entry ${name}`);
    const key = `${entry.repo ?? ''}:${entry.entity}:${entry.number}`;
    if (seen.has(key)) throw new Error(`duplicate watch entry ${name}`);
    seen.add(key);
    entries.push({ ...entry, __filename: name });
  }
  for (const entry of entries)
    if (watchFilename(entry) !== entry.__filename)
      throw new Error(`invalid watch entry ${entry.__filename}`);
  return entries
    .map(({ __filename, ...entry }) => entry)
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.number - b.number);
}

export function addWatch(dir, raw, until, { now = () => new Date().toISOString(), repo } = {}) {
  const item = parseWatchItem(raw);
  if (!['closed', 'merged'].includes(until) || (item.entity === 'issue' && until !== 'closed'))
    throw new Error(
      `--until must be ${item.entity === 'pr' ? 'merged or closed' : 'closed'} for ${item.entity}`,
    );
  mkdirSync(dir, { recursive: true });
  const scoped = repo ? { ...item, repo } : item;
  const path = join(dir, watchFilename(scoped));
  return locked(path, () => {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (
        valid(existing) &&
        existing.entity === item.entity &&
        existing.number === item.number &&
        existing.repo === repo &&
        existing.until === until
      )
        return { added: false, entry: existing, path };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`invalid watch entry ${watchFilename(scoped)}`);
    }
    const entry = { ...scoped, until, addedAt: now() };
    atomic(path, entry);
    return { added: true, entry, path };
  });
}
export function listWatch(dir) {
  return readWatch(dir);
}
export function removeWatch(dir, raw, { repo } = {}) {
  const item = parseWatchItem(raw);
  const path = join(dir, watchFilename(repo ? { ...item, repo } : item));
  return locked(path, () => {
    try {
      unlinkSync(path);
      return { removed: true, path };
    } catch (err) {
      if (err.code === 'ENOENT') return { removed: false, path };
      throw err;
    }
  });
}
export function removeWatchUnchanged(path, bytes) {
  return locked(path, () => {
    try {
      if (readFileSync(path, 'utf8') !== bytes) return false;
      unlinkSync(path);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  });
}

// The compare-then-mutate logic itself, WITHOUT acquiring the entry's lock.
// Exported for withTerminalMarkLocks below, whose whole purpose is to let a
// caller hold that lock across more than just this one write -- calling the
// locked, public markTerminalIgnored from inside an already-held lock would
// self-block (acquireLock has no concept of reentrancy; it would see its
// own live lock file and report "held"). markTerminalIgnored composes this
// with `locked()` for every OTHER caller, which never needs to hold the
// lock past a single write.
//
// Idempotent FIRST: a call against an entry that already carries
// `ignoredTerminalAt` succeeds immediately without comparing bytes or
// touching the file -- a second watched transition detected in the same
// tick (or a retry after a partial failure) always finds "already marked"
// regardless of whether the bytes it read have since gone stale from the
// FIRST mark's own write. Only an entry that still needs marking goes
// through the same compare-then-mutate shape as removeWatchUnchanged: a
// no-op (returning `false`) if the on-disk bytes no longer match what this
// tick read at the start (a concurrent `watch rm`/`watch add`/another
// monitor process replaced the entry -- never clobber that).
export function writeTerminalIgnoredLocked(path, bytes, ignoredAt) {
  try {
    const raw = readFileSync(path, 'utf8');
    const entry = JSON.parse(raw);
    if (entry.ignoredTerminalAt !== undefined) return true;
    if (raw !== bytes) return false;
    atomic(path, { ...entry, ignoredTerminalAt: ignoredAt });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Durably record that a watched item's terminal transition (a merge or
 * close matching its `until`) was observed but suppressed by the current
 * tick's attention filters, so a LATER, unrelated delta -- one carrying no
 * transition class of its own, because the state does not change twice --
 * does not silently clean up the entry while the same filter is still in
 * effect (see lib/cli.mjs's isTerminalCleanupEligible/
 * watchedTerminalTransitionSuppressed). Most callers want this: acquire,
 * write, release, all in one call. The detector tick does not -- see
 * withTerminalMarkLocks below.
 */
export function markTerminalIgnored(path, bytes, ignoredAt) {
  return locked(path, () => writeTerminalIgnoredLocked(path, bytes, ignoredAt));
}

/**
 * Hold EVERY named watch entry's own lock for the entire duration of `fn`,
 * so a concurrent `watch add`/`rm` on any of them cannot land in the middle
 * of whatever `fn` does while they are held.
 *
 * Why this exists (round 9 of the same finding): marking a filtered
 * terminal transition as ignored and then publishing the snapshot that
 * records that terminal state must commit as ONE indivisible step relative
 * to a replacement of the SAME watch entry. Every earlier round moved the
 * boundary of a check -- verify the mark survived, then re-verify
 * immediately before publication -- and each move only shrank a
 * time-of-check-to-time-of-use window, never closed it, because the check
 * and the snapshot write were always two separate operations with no lock
 * held across both. Holding the entry's own lock across that whole span
 * removes the window instead of narrowing it again: `addWatch`'s replace
 * path acquires this SAME lock before it can touch the file (see `locked`
 * above), so for the specific race this line of fixes has chased --
 * `watch add` replacing an entry while its terminal transition is being
 * recorded -- the replacement can now only happen strictly before this
 * function starts or strictly after it returns, never during. If the lock
 * is already held (from a still-live prior call, not one we can steal),
 * the concurrent `watch add`/`rm` fails fast with "watch entry locked"
 * instead of racing -- an honest, retryable error in place of silent
 * corruption.
 *
 * Deadlock safety, checked against every lock-acquiring path in this
 * codebase, not assumed: `watch add`/`rm` (lib/cli.mjs's runWatch) only
 * ever acquire ONE entry lock at a time and NEVER the state-file lock;
 * `reset` and the detector tick only ever acquire the state-file lock and
 * NEVER an entry lock, except the detector tick calling INTO this function,
 * which always already holds the state-file lock first. So the only
 * ordering that exists anywhere is state-file lock -> entry lock(s), never
 * the reverse -- no cycle is possible. Entry locks among THEMSELVES are
 * acquired in a stable sorted order (irrelevant to safety here, since
 * nothing else ever acquires more than one, but cheap and conventional).
 *
 * Bounded critical section -- but bounded by `leaseMs`, a duration meaning
 * ONLY "how long may this entry legitimately stay locked", never by
 * `--gh-timeout-ms`. Round 10 of this line of fixes: the first version of
 * this function accepted `{ghTimeoutMs, staleMs}` and the caller passed the
 * detector's OWN `--gh-timeout-ms`/`--lock-stale-ms` straight through -- but
 * `fn` here does a disk write (a mark write, then a full snapshot
 * serialize-and-rename), not a GitHub API call, and a user has no reason to
 * expect tuning their NETWORK timeout down to also shorten a FILESYSTEM
 * lock's lease. Set `--gh-timeout-ms` below the actual snapshot write time
 * and the lease expires mid-publish, a concurrent `watch add` legitimately
 * steals the "abandoned" lock, and the unmarked-replacement race this whole
 * mechanism exists to close returns -- silently, and for a reason that has
 * nothing to do with anything the operator was adjusting.
 *
 * Round 11 of this same finding then reused `--lock-stale-ms` instead,
 * reasoning it was already the user-facing knob for "how long before a lock
 * may be treated as abandoned". Round 12 found that reasoning wrong: both
 * `lib/help.mjs` and `docs/contract.md` document `--lock-stale-ms` as
 * governing ONLY an UNREADABLE/corrupt lock (a kill mid-write can truncate
 * one) -- never a READABLE lock's `expiresAt`, which this lease actually
 * becomes (see lib/lock.mjs's acquireLock). An operator has every reason to
 * set `--lock-stale-ms` small -- it is documented as a corrupt-lock
 * detection ceiling, not a work-duration budget -- with nothing telling
 * them that doing so also shortens THIS unrelated critical section:
 * `--lock-stale-ms 1s` reused the same way `--gh-timeout-ms` was in round
 * 10 reintroduces the exact same bug, just through the other flag.
 *
 * `leaseMs` therefore defaults to ENTRY_LOCK_LEASE_MS, a duration this
 * module owns outright -- not derived from any user-facing flag. Two other
 * shapes were weighed and rejected:
 *   - Deriving it from the work itself (e.g. timing a prior mark+publish and
 *     sizing the next lease off that) adds a feedback loop to a mechanism
 *     that exists purely to be boring: the lease only has to outlast one
 *     disk write, and a self-tuning duration can undershoot on first run or
 *     after a slow outlier, which is worse than a fixed generous constant.
 *   - Keeping a flag but documenting that it now ALSO sizes this lease is
 *     the worst option: it turns one simple, single-purpose knob into two
 *     unrelated ones sharing a name, and every future reader has to
 *     rediscover the coupling before touching either meaning.
 * A fixed internal constant needs no operator input at all: `fn` is always
 * the same two-step disk write regardless of repo size, network conditions,
 * or anything else a flag might reasonably tune, so there is no legitimate
 * case for varying it. Renewal (extending the lease mid-publish, the way
 * the state-file lock extends itself per completed GitHub fetch page) was
 * considered and rejected here too: a lease this generous relative to a
 * local disk write does not need it, and renewal is exactly where a mistake
 * becomes a worse bug than the one it replaces -- a renewal that lands
 * after the lease has already been legitimately stolen leaves both the
 * original holder and the thief believing they own the lock. A fixed,
 * generous lease has no such failure mode: it either covers the work or it
 * does not, and if it genuinely is not generous enough for some disk, that
 * is a constant to raise here, in code, not a flag to reach for.
 *
 * Released in a `finally`, in reverse acquisition order, whether `fn`
 * succeeds, throws, or the process is otherwise unwound -- a process that
 * dies harder than that (a kill -9) leaves the lock as any other abandoned
 * lock in this codebase does: visible, and reclaimable once it is provably
 * older than `leaseMs` (see lib/lock.mjs's acquireLock).
 *
 * Known, separate, pre-existing coupling NOT addressed here (found while
 * checking for this exact pattern elsewhere, per this round's own ask):
 * lib/cli.mjs's durable-log write (`appendDeltaLog`'s `onProgress`) extends
 * the STATE-FILE lock's deadline using `ghTimeoutMs` too, immediately
 * before a disk operation (a log scan-and-append) rather than a network
 * call -- and more broadly, nothing re-extends the state-file lock's
 * deadline between the last completed GitHub fetch page and the eventual
 * snapshot write, so that whole tail of a tick (detect, enrich, log write,
 * snapshot write) implicitly relies on the LAST fetch-driven extension
 * (`now + --gh-timeout-ms + 5s`) being enough time for all of it. This is a
 * pre-existing property of the state-file lock, not introduced by this
 * function, and is a separate decision from the one this round makes for
 * the entry lock.
 */
// How long a mark write plus a full snapshot serialize-and-rename may
// legitimately hold one watch entry's lock -- see withTerminalMarkLocks'
// doc comment (round 12) for why this is a fixed internal constant rather
// than derived from any user-facing flag. 10 minutes matches the generous
// margin --lock-stale-ms's own default happened to provide before that
// coupling was removed; raise it here, in code, if a real disk ever needs
// more, never by pointing a flag at it.
export const ENTRY_LOCK_LEASE_MS = 10 * 60 * 1000;

export function withTerminalMarkLocks(paths, fn, { leaseMs = ENTRY_LOCK_LEASE_MS } = {}) {
  const held = [];
  try {
    for (const path of [...new Set(paths)].sort()) {
      const acquired = acquireLock(path, { ghTimeoutMs: leaseMs, staleMs: leaseMs });
      if (!acquired.ok) {
        const err = new Error(`watch entry locked: ${path}`);
        err.kind = 'watch-entry-busy';
        throw err;
      }
      held.push({ path, token: acquired.token });
    }
    return fn();
  } finally {
    for (let i = held.length - 1; i >= 0; i--) releaseLock(held[i].path, held[i].token);
  }
}
