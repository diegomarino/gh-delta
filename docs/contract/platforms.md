# Platform Notes

[Documentation](../README.md) · [Contract reference](../contract.md)

`gh-delta` targets Node >= 22 on any OS, but the [snapshot guarantees](snapshots.md) and [lock guarantees](locks.md) are
POSIX-worded. CI exercises Linux only; macOS shares the POSIX semantics.
On **Windows** the behavior degrades explicitly, never silently:

- **Atomic writes.** Snapshot and registry writes go through a unique temp file
  plus rename. The rename is guaranteed atomic on POSIX within one filesystem;
  on Windows it is a best-effort `MoveFileEx`-style replace — safe against
  partial JSON, but without the same atomicity guarantee under concurrent
  writers. The "serialize ticks per monitor" rule matters more there.
- **Permissions.** The `0700` modes on the temp-dir default and the registry
  directory are ignored on Windows (ACLs come from the user profile), and the
  temp-dir ownership guard (refusing a default dir owned by another uid) is
  skipped — `process.getuid` does not exist on Windows.
- **Locations.** The temp-dir default resolves under `%TEMP%`
  (`os.tmpdir()`); the run registry lands at
  `%USERPROFILE%\.local\state\gh-delta\registry` unless `XDG_STATE_HOME` or
  `GH_DELTA_REGISTRY_DIR` overrides it. Both are echoed in reports
  (`results[].stateFile`, `registryDir`) — trust the echo, not the convention.
- **Case-insensitive paths.** Registry entry keys and `gh-delta list` dedupe
  keys case-fold the resolved snapshot path on Windows, so `C:\State\x.json`
  and `c:\state\x.json` are one monitor, not two. On POSIX, paths that differ
  by case are genuinely different files and are kept distinct.
- **GraphQL schema age (GitHub Enterprise).** The PR query's `reviewRequests`
  selection spreads an inline fragment on `Bot` and selects
  `Team.combinedSlug` — both newer schema members, verified against
  github.com. On a GHES version whose `RequestedReviewer` union predates
  `Bot` (or lacks `combinedSlug`), GraphQL **validation rejects the whole
  query** and every tick fails with a `github` error. See also the
  `failedChecks.runId`/`jobId` GHES limitation in
  [Delta Summary schema](summary.md#delta-summary-schema) — both stem from the same
  root cause: `--repo` carries no host component, so gh-delta cannot select a
  host-aware code path. If you run against an older GHES and hit the query
  rejection, report it — the fix would ship as an **opt-in compatibility
  selection** for those hosts (e.g. an env knob switching to `slug`, no `Bot`
  fragment), never as a degradation of the github.com default, which would
  lose Copilot-reviewer detection for everyone.
