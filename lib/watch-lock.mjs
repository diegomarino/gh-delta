// Internal watch-entry locking helpers. NOT part of the published API: this
// module has no `./watch-lock` entry in package.json#exports. It exists
// purely so lib/watch.mjs and lib/cli.mjs can share the mark/lock mechanics
// without publishing them -- writeTerminalIgnoredLocked in particular has a
// contract ("the caller already holds this entry's lock") that a published
// module cannot express or enforce, so it must never be reachable from
// `import ... from 'gh-delta/watch'`.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { acquireLock, releaseLock } from './lock.mjs';

export function atomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}

// The compare-then-mutate logic itself, WITHOUT acquiring the entry's lock.
// Exported for withTerminalMarkLocks below, whose whole purpose is to let a
// caller hold that lock across more than just this one write -- calling the
// locked, public markTerminalIgnored from inside an already-held lock would
// self-block (acquireLock has no concept of reentrancy; it would see its
// own live lock file and report "held"). lib/watch.mjs's markTerminalIgnored
// composes this with its own `locked()` for every OTHER caller, which never
// needs to hold the lock past a single write.
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
//
// Not published: this function assumes the caller ALREADY HOLDS the entry's
// lock (via withTerminalMarkLocks below). Calling it without that lock held
// can corrupt watch state -- there is no way to express or verify that
// precondition from the function's signature alone, so it must stay an
// internal implementation detail rather than a supported export.
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
 * path acquires this SAME lock before it can touch the file (see
 * lib/watch.mjs's `locked`), so for the specific race this line of fixes
 * has chased -- `watch add` replacing an entry while its terminal
 * transition is being recorded -- the replacement can now only happen
 * strictly before this function starts or strictly after it returns, never
 * during. If the lock is already held (from a still-live prior call, not
 * one we can steal), the concurrent `watch add`/`rm` fails fast with "watch
 * entry locked" instead of racing -- an honest, retryable error in place of
 * silent corruption.
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
 *
 * Not published: this composes writeTerminalIgnoredLocked, so it inherits
 * the same "internal mechanism, not a supported entry point" reasoning.
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
