# Cron-Native Tick

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

Each scheduled tick should run the detector and then stop. The scheduler already
owns the next fire.

The detector uses at-most-once delivery semantics: a successful detection writes
the new snapshot before the agent acts on the printed deltas. Persist the tick
output in scheduler logs before taking action. If you need at-least-once action
delivery, wrap `gh-delta` with an external queue or acknowledgement layer.
`--omit-end` does not acknowledge delivery. Its stderr diagnostics still count
toward a consumer's output cap.

Local watch labels are routing context, not proof of ownership. Upgrade every
reader and writer of a shared watch directory before using labels: old binaries
reject labeled entries. Eight full-size labels can consume much of a
4,000-character consumer budget. This feature does not truncate output or
acknowledge delivery.

`--format template` does not truncate lines to 4,000 characters and does not
acknowledge delivery. `read --advance` still records consumption before a
consumer is guaranteed to have stored the line. Hash `--template-sha256` against
raw file bytes; interpolated GitHub text remains untrusted.

The same rule applies to optional outposts. If `--outpost-url` is configured, the
snapshot has already advanced before each outbound POST is attempted. A failed
outpost does not roll back the snapshot, does not retry, and does not change the
tick exit code.

Use this order inside each tick:

1. Do not create or modify the schedule from inside the tick.
2. Run `gh-delta --format text`.
3. Branch on its exit code.
4. Act on each listed delta when exit code is `10`.
5. On exit `1` (transient), log the error; the next scheduled fire will retry.
6. On exit `2` (permanent), stop the loop and alert the operator — the
   configuration or snapshot must be fixed by a human.
7. Stop this tick.

Tick command:

```bash
gh-delta \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr,issue \
  --format text
```

Optional outpost command:

```bash
gh-delta \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr,issue \
  --format text \
  --outpost-url https://example.com/gh-delta
```

Exit codes: see [Exit Codes](../contract/exit-codes.md#exit-codes). On `10`, act on each
listed delta; on `1` (transient), log the error and let the next scheduled fire
retry automatically; on `2` (permanent), stop the loop and alert the operator —
the configuration or snapshot must be fixed by a human before retrying.

Heartbeat format:

```text
<timestamp> | <N> delta(s)
```

Use `--format json` when another program needs the raw structured report.

**Cadence and rate limit:** a typical tick costs ~20 GraphQL points (8 per PR
page + 2 per issue page, × two fetch phases) against GitHub's 5,000
points/hour-per-token budget — generous for one monitor, shared across all
monitors on the same token. Numbers and how to spend less:
[Fetch limits](../contract/snapshots.md#fetch-limits-page-caps).
