# Requirements

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

- Node.js 18 or newer.
- GitHub CLI (`gh`) installed and authenticated.
- A writable path or directory for snapshot state.
- A scheduler: cron, launchd, systemd, GitHub Actions, Claude Code `/loop`,
  Claude Code `CronCreate`, Codex automation, or another equivalent clock owner.

> **Note:** scheduled and durable monitors must pass an explicit `--state-dir`
> pointing at a persistent directory. The default (no `--state-dir` and no
> `--state-file`) uses a per-user temp directory that is ephemeral — reboots and
> tmp cleanup silently re-seed the baseline. That default is suitable for casual
> CLI runs and agent loops that can tolerate post-reboot re-baselines.

> **Monitor naming:** pass `--monitor-id` explicitly for any durable, scheduled,
> or multi-cadence monitor, and always in CI — CI runners with per-job hostnames
> produce a new `host-` default on every job, which means an eternal baseline and
> no deltas ever. If two users share an explicit `--state-dir` on one machine,
> they derive the same `host-` id — and therefore the same snapshot file —
> silently clobbering each other's baselines; name monitors explicitly for shared
> state dirs.

## Seed The Baseline

Run the detector once before creating the recurring job:

```bash
gh-delta \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr,issue \
  --format json
```

The first successful run should return a report whose `results[0].baseline` is
`true` (there is no top-level `baseline` field) and exit `0`. That is normal.
It seeds the snapshot so the first scheduled tick compares against known
state instead of reporting every existing issue or PR as new.

To audit which monitors already exist on a machine — before adding one, or when
inheriting a host — run the read-only inventory:

```bash
gh-delta list --format text
```

It reports each monitor's repo, id, entities, and last run from the
[run registry](../contract/registry.md#run-registry) plus the temp default location,
flags registered monitors whose snapshot is gone as `stale`, and never touches
snapshots, so it is safe alongside live ticks. `--since 24h` shows only
recently active monitors.
