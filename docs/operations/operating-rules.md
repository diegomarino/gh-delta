# Operating Rules

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

- Do not edit snapshot files by hand. The tool owns them.
- On exit `2` for an unreadable, corrupt, or pre-schema-v2 snapshot/log, run
  `gh-delta reset --repo <owner/name> --monitor-id <id>
(--state-file <path>|--state-dir <dir>) --entities <entities> --yes` — the
  documented recovery — then let the next tick re-seed the baseline. When
  using `--state-dir`, `--entities` must match the monitor's own entity
  selection: the snapshot filename is scoped by the canonical entity set, and
  omitting `--entities` reverts to the default `pr,issue`. Against a monitor
  running with a narrower selection (e.g. `--entities pr`) that resolves to a
  different snapshot path. Inspect `targets[].removed` and
  `targets[].missing` to confirm the selected path before the next tick.
  **`--watch-dir` monitors with `--state-dir` are reset automatically.**
  `reset` resolves both the standard entity-scoped path and the economical
  `__watch-pr.json` sibling, locks both, and reports every removed or absent
  path in `targets`. For an explicit `--state-file`, the path stays exact;
  pass the actual `<state-file>.watch.json` when resetting that explicit watch
  state. Inspect `targets[].removed` rather than relying only on exit `0`.
  See [Troubleshooting](../troubleshooting.md) for the full recovery flow.
- Keep scheduler logs for tick output. A delta is acknowledged by snapshot
  advancement before any downstream action completes.
- If using `--outpost-url`, make the endpoint idempotent and deduplicate by
  `delta.id` (or `deliveryId` for delivery-attempt idempotency); `gh-delta`
  does not retry or persist failed sends.
- Do not call `ScheduleWakeup` from a cron-owned tick.
- Do not call `ScheduleWakeup` from a subagent-owned tick; Claude Code does not
  expose it to subagents.
- Do not create another cron from inside a cron-owned tick.
- Do not run overlapping ticks against the same state file. If your scheduler
  can overlap jobs, add external locking or increase the interval. This rule is
  also exposed in `gh-delta --help-json` as `stateConcurrency` for agent and
  scheduler tooling.
- `watch sync` replaces the whole `--watch-dir`. Redirect its JSON stdout away
  from detector output. Check the producer’s exit code before sync; a complete
  `end N` frame does not mean the producer succeeded. `--repo` is not a
  partial-update filter. After `watch-set.json` exists, leftover per-entry
  files are not part of the set. Mixed-version binaries and network
  filesystems are not a supported fencing upgrade.
- If the command exits `1` with "exceeded N pages — narrow the monitor scope or
  re-seed the baseline", do exactly that before continuing. The tool fails closed
  rather than silently truncating. Open items are capped at 1 000 per family;
  updated items per tick are capped at 3 000. Repeated occurrences of this exit
  on consecutive ticks are an operator-action signal — narrow the scope or
  re-seed; this is not a transient error to retry indefinitely.
- Do not merge a PR blind on green CI alone. Read review comments first.
- If the same delta refires every tick, stop and investigate instead of acting
  repeatedly.
- If you need a different cadence, update the scheduler outside the tick. For
  session-scoped Claude Code crons, that means delete and recreate the cron.
- `--watch-strict` does not bound total runtime by a consumer's 60-second
  scheduler timeout. `--gh-timeout-ms` applies to each GitHub call, and
  sequential batches can outlive the scheduler. The feature does not guarantee
  delivery to the downstream consumer. A later batch failure or admission
  refusal still publishes nothing; inspect `results[].rateLimit` for already
  validated GraphQL costs from earlier batches.
