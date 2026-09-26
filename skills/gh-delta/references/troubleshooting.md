# Troubleshooting and recovery

## Upgrade from pre-0.7 state

gh-delta 0.7.0 uses report and snapshot schema v2. Old snapshots and durable
logs are rejected with exit `2` (`snapshot` or `log`); there is no automatic
migration. Changing a version field by hand does not convert the data.
Watch entries and cursor files have their own formats; a report schema bump
does not mean rewriting their version fields.

1. Stop the exact producer and its consumers through their owning launcher.
   Inspect `gh-delta list --state-dir "$STATE_DIR" --format json`, the last
   report, and the error to identify the affected snapshot and log. Preserve
   a recovery copy of the snapshot, log manifest, physical log data, and each
   consumer cursor before an intentional reset.
2. When the requested recovery authorizes discarding that monitor's baseline
   and log, use `gh-delta reset` with its exact repository, monitor ID, entity
   selection, and state path. For an ordinary producer whose state is derived
   from `$STATE_DIR`, the command is:

   ```bash
   gh-delta reset \
     --repo "$REPO" --monitor-id "$MONITOR_ID" \
     --entities pr --state-dir "$STATE_DIR" --yes --format json
   ```

   Match `--entities` to the existing producer. For an explicit snapshot,
   replace `--state-dir` with `--state-file` and the exact path. An economical
   watch uses a separate snapshot (`__watch-pr.json` or `.watch.json`);
   `reset` does not accept `--watch-dir`. Pass the watch's actual snapshot
   path with `--state-file` and verify that its derived log matches the
   producer's recorded log path. `--yes` confirms deletion of the selected snapshot,
   log manifest, and physical log data; this is not a conversion or dry run.

3. A consumer cursor beyond the reset log's empty tail is rejected. Archive
   the exact stale cursor and recreate it at sequence `0`, bound to the
   producer's actual log path, using the consumer pattern in `patterns.md`.
   Coordinate this with downstream acknowledgement; resetting does not
   preserve replay history.
4. Run the producer with its original scope to establish a fresh baseline.
   Confirm schema v2 and the matching JSON `results[]` row's `baseline` and
   absence of `error` before resuming its schedule and consumers. The baseline
   is normally quiet; `--baseline-emit-state` intentionally emits existing
   open items and can trigger downstream work.

For exact reset and cursor behavior, consult the
[reset contract](https://github.com/diegomarino/gh-delta/blob/main/docs/contract.md#gh-delta-reset).

## `gh: HTTP 502`

Treat an HTTP 502 as a transient GitHub fetch failure first. `gh-delta` exits
`1`, leaves the snapshot unchanged, and tells the scheduler to retry. Preserve
the snapshot and wait for the next scheduled tick; do not delete or reseed
state.

Common causes include:

- a temporary GitHub GraphQL or edge-service failure;
- a proxy, VPN, or network path returning an upstream 502;
- a broad GraphQL observation that asks for many PRs and nested CI, review,
  comment, thread, label, assignee, and review-request connections;
- a long-lived, high-activity repository whose open or recently updated set is
  too large for a reliable broad observation.

If the next scheduled tick fails again:

1. Run the read-only diagnostic:

   ```bash
   gh-delta doctor --repo "$REPO" --state-dir "$STATE_DIR" --format text
   ```

2. Check [GitHub Status](https://www.githubstatus.com/) and verify that a small
   authenticated GraphQL request works:

   ```bash
   gh api graphql -f query='query { viewer { login } rateLimit { remaining resetAt } }'
   ```

3. If small requests work but broad ticks repeatedly fail, narrow the entity
   family or use a PR-only `--watch-dir` containing at most ten entries. Do not
   substitute `--number`: it filters after the broad fetch.
4. Keep the existing snapshot. Only repair or intentionally reseed after a
   permanent snapshot/configuration error (exit `2`), and copy the owned state
   first.

## Other common failures

| Symptom                                     | Meaning and response                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Exit `1`, authentication/connectivity error | Snapshot unchanged. Run `doctor`, repair `gh auth` or connectivity, retry on schedule.                                    |
| Exit `1`, rate-limit floor                  | Snapshot unchanged. Wait until `resetAt` or reduce scope/cadence.                                                         |
| Open-items page cap                         | More than 1,000 open items in one entity family. Narrow entities or use a targeted PR watch.                              |
| Updated-items page cap                      | More than 3,000 items changed since the snapshot horizon. Shorten cadence or narrow scope; do not accept partial state.   |
| Nested pagination overflow                  | One PR has more observable nested rows than the supported complete page. Inspect that item and keep fail-closed behavior. |
| `busy` or active lock                       | Another producer owns this snapshot. Wait; do not overlap identities or delete a live lock.                               |
| Exit `2`, corrupt snapshot/config           | Stop automatic retries. Inspect the named file/config, preserve a recovery copy, then repair or deliberately reseed.      |
| Unexpected quiet first run                  | Normal baseline behavior. Use `--baseline-emit-state` only when pre-existing state must be emitted explicitly.            |

## Stable documentation URLs

- README and install: <https://github.com/diegomarino/gh-delta#readme>
- Canonical contract: <https://github.com/diegomarino/gh-delta/blob/main/docs/contract.md>
- Usage guide: <https://github.com/diegomarino/gh-delta/blob/main/docs/usage.md>
- Copyable recipes: <https://github.com/diegomarino/gh-delta/blob/main/docs/recipes.md>
- Troubleshooting: <https://github.com/diegomarino/gh-delta/blob/main/docs/troubleshooting.md>
- Scheduler/agent loop: <https://github.com/diegomarino/gh-delta/blob/main/docs/watch-loop-prompt.md>
- Examples: <https://github.com/diegomarino/gh-delta/tree/main/examples>
- Releases: <https://github.com/diegomarino/gh-delta/releases/latest>

The repository's `docs/contract.md` is authoritative for fields, exit codes,
snapshot guarantees, and limits. This skill chooses an operating pattern; it
does not replace the contract.
