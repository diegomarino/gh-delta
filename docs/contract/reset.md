# gh-delta reset

[Documentation](../README.md) · [Contract reference](../contract.md)

```
gh-delta reset --repo <owner/name> --monitor-id <id>
  (--state-file <path>|--state-dir <dir>) --yes
  [--entities pr,issue] [--format json|text]
```

Deletes one monitor's snapshot and durable log to start a clean baseline. This
is the documented recovery for a monitor stuck on an unreadable or
pre-schema-v2 snapshot/log — schema v1 is never migrated (see the [schema-v1 recovery note](../contract.md)). With `--state-dir`, reset resolves the selected poll snapshot and the strict
watch snapshots that belong to that entity selection: `pr` also deletes
`watch-pr`; `issue` also deletes `watch-issue` and does not delete `watch-pr`;
`pr,issue` also deletes `watch-pr` and `watch-pr-issue` and does not delete
`watch-issue`. It locks every target in stable path order and releases the
locks last. A concurrent tick against any of those identities therefore sees
the fully intact pre-reset state or the fully clean post-reset state, never a
half-deleted monitor. `--state-file` remains an exact explicit target and does
not follow strict siblings. Each target deletes its snapshot file, published log
manifest, and log data file. `--yes` is required; without it, reset is refused
before any lock is acquired. A monitor with nothing on disk resets
successfully as a no-op.

The success report retains the primary `stateFile` and `logFile` paths and
adds `targets`: each `{scope,stateFile,logFile,removed,missing}` records the
poll or watch target and the exact paths removed or found absent (see
`RESET_REPORT_FIELDS` and `RESET_TARGET_FIELDS` in `gh-delta/contract`).

**External cursor behavior after reset.** An external consumer cursor bound to
the deleted log now points past its (fresh, empty) tail — `seq > 0` against a
log with `lastSeq: 0`. `gh-delta read` / `cursor set` **reject** it with
`kind: "log"` naming the cursor seq and the tail, rather than silently
restarting delivery from the new `firstSeq`. This is deliberate: a silent
restart would re-deliver history the consumer already believes it has
consumed. Delete the stale cursor file to resume (tested at
`test/deltalog.test.mjs`, "a cursor pointing past the tail of a reset (deleted)
log is a clear log error, not a silent restart").

Exit codes: `0` reset completed (including a no-op reset of a clean monitor),
`1` filesystem or lock-busy error, `2` invalid arguments or `--yes` not passed.

**Irreversible:** the snapshot and durable log are deleted, not archived.
