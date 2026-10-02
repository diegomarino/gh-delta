# Lock Semantics

[Documentation](../README.md) · [Contract reference](../contract.md)

One writer at a time per `(repo, monitorId, entities)` — i.e. per resolved
`stateFile`. A lock file at `<stateFile>.lock` guards the read-fetch-write
window; a second run contending for the same state file gets a visible
`busy` error (exit `1`, transient) instead of a silent lost update.

**Why a lock at all, given atomic writes.** `writeSnapshotAtomic` (temp file +
rename) prevents a reader ever seeing partial JSON, but it does not prevent
two independent writers from racing: both read the same old snapshot, both
fetch GitHub, and both write — the second rename wins and the first run's
observations vanish without a trace. The lock turns that into a loud,
retryable error.

**Contents:** `{ token, pid, host, acquiredAt, expiresAt }`, where `token` is
a fresh `randomUUID()` identifying this one acquisition (not the process or
monitor).

**`expiresAt` sizing: a short initial lease, extended per completed page —
not a ceiling sized for the worst case.** `lib/gh.mjs` paginates each entity
family (`--gh-timeout-ms` applies to _every_ `gh` subprocess call, and a
family can make up to 10 open-item pages plus 30 updated-item pages). Sizing
the deadline for that worst case up front would mean a genuinely crashed run
could squat on the lock for tens of times `--gh-timeout-ms`. Instead:

- **Acquire time:** `expiresAt = acquiredAt + --gh-timeout-ms + a fixed
slack` — enough to cover exactly one `gh` call, not the whole run.
- **Per completed page:** `lib/gh.mjs` calls an `onProgress` hook after each
  pagination page's `gh` call returns successfully; `lib/cli.mjs` wires that
  hook to push `expiresAt` forward to `now + --gh-timeout-ms + slack` again.
  This happens between two `execFileSync` calls — ordinary synchronous
  control flow, not a timer — so it reliably runs even though `execFileSync`
  blocks the single JS thread during each page. The extension itself verifies
  ownership first (never extends a lock whose on-disk token is not ours) and
  writes the updated record atomically (temp file + rename), so a concurrent
  reader can never observe a torn write.
- **A fetch that stops making progress** (hung, or the process died) simply
  stops calling the hook and expires on schedule, exactly as if it had never
  extended at all.

This is a genuine departure from "no lease renewal": earlier revisions of
this document said renewal never happens, reasoning that a `setInterval`
timer cannot fire while `execFileSync` blocks the thread. That reasoning is
correct about _timers_ specifically — it does not apply to an explicit call
made between two already-synchronous operations. The distinction that
matters: this is not a timer-driven heartbeat lease (which would need to
interrupt a blocking call to renew), it is a progress-driven extension (which
only needs to run at points where control flow already returns to JS).

**Protocol:**

1. **Acquire.** An atomic exclusive-create publish (temp file, written in
   full, then linked into place — `linkSync` fails `EEXIST` if the path is
   already occupied, exactly like the `open(path, 'wx')` this replaced, but
   without a window where a concurrent reader could see an empty,
   not-yet-written file). If the file already exists, its `expiresAt` is
   read: in the future means a live holder (`busy`); in the past means an
   abandoned lock, stolen below. Acquiring also creates the state file's
   parent directory (recursive `mkdir`) if it does not exist yet — the lock
   runs before `writeSnapshotAtomic`, which used to be the thing that created
   it lazily, so an explicit `--state-dir`/`--state-file` on a first run
   needs this to avoid failing with `ENOENT`.
2. **Steal by rename, not read-verify-delete — and verify what actually got
   renamed.** An expired (or, past `--lock-stale-ms`, unreadable) lock is
   stolen with an atomic rename to a throwaway name, never by reading it,
   checking, and then unlinking. Rename is atomic, so of two simultaneous
   thieves targeting the lock file exactly one succeeds; the other gets
   `ENOENT` and reports `busy`. That alone is not sufficient: two contenders
   can both read the _same_ expired lock before either renames it away — the
   first renames it and publishes its own fresh lock, and the second's rename
   (still targeting the original path) then captures that fresh, unexpired
   lock instead of the expired one it inspected. So after the rename lands,
   the thief re-reads the renamed-away file and checks it is still the same
   expired (or corrupt) lock it decided to steal. If a live lock ended up
   renamed instead, the thief renames it back to the lock path and reports
   `busy` rather than proceeding — it never creates a competing lock at that
   point.
3. **A corrupt lock never deadlocks the state file.** A process killed
   mid-write can leave a truncated, unreadable `.lock`. An unreadable lock
   younger than `--lock-stale-ms` reports `busy` (it might still belong to a
   live holder); older than that, it is presumed abandoned and stolen, with a
   `{ label: "lock", reason }` entry in the report's `warnings` array so an
   operator can see it happened.
4. **Release verifies ownership on the same object it deletes.** The holder
   renames the lock file to a private throwaway path first — one filesystem
   object, so there is exactly one thing to check — then verifies the
   on-disk token there still matches its own before unlinking it. If it does
   not match, the rename is undone and the file is left alone. This is what
   makes stealing safe: a slow-but-alive holder whose lock was stolen and
   replaced while it was still fetching must never delete a lock that now
   belongs to someone else. (An earlier version of this protocol read the
   token and then unlinked as two separate operations against the live path;
   that left a gap for a steal to land in between, after which the "verified"
   read was stale by the time the unlink ran.)
5. **The fence runs twice, narrowing the window down to the final rename.**
   Immediately after fetching, the lock is re-read and the token re-verified;
   if it no longer matches, the run fails with `busy` and writes nothing —
   this is the cheap check, since failing here skips the JSON
   serialize/temp-write work entirely. `writeSnapshotAtomic` also accepts a
   `verifyBeforeCommit` callback, invoked immediately before its own final
   `renameSync` — the same ownership check, run a second time right at the
   syscall that actually publishes the snapshot. Losing ownership strictly
   between the two checks (a steal landing after the cheap check passes but
   before the temp file is renamed into place) is caught by the second one
   instead of silently clobbering the thief's already-written snapshot.

**Honesty about the residual race.** Even with both fence checks, the
ownership-verifying read and the snapshot's `renameSync` are two syscalls
against two different files, not one atomic operation — the OS scheduler can
still preempt between them. This **narrows** the lost-update window from the
entire fetch duration down to that single remaining syscall gap; it does
**not** eliminate the race. No POSIX (or Windows) filesystem primitive gives
two independent files a compare-and-swap. Treat the lock as a strong, loud
guard against the common case (overlapping ticks, a slow holder outlasted by
a faster one, a hung fetch), not a formal mutual-exclusion proof. The watch
directory lock (`.gh-delta-watch.lock`, 10m internal lease) uses the same
primitives: it does not claim safety past lease expiry or on network
filesystems.

**`--lock-stale-ms`** (default `10m`) only bounds the unreadable/corrupt case
above; a readable lock is stolen purely on its own `expiresAt`, regardless of
this flag.

**Deleting a `.lock` file by hand is always safe.** At worst, a live holder
loses its fence check and its own next write attempt reports `busy` — the
snapshot itself is never corrupted, because `writeSnapshotAtomic`'s atomicity
is independent of the lock.
