# Snapshot Identity

[Documentation](../README.md) · [Usage by task](../usage.md)

Think of `--monitor-id` as the stable name of one recurring watcher. Use the same
id for repeated ticks of the same monitor and a different id when you want
independent state.

```bash
gh-delta --repo org/app --monitor-id prs-5m --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --entities pr
```

With `--state-dir`, `gh-delta` derives a snapshot path from the repo, monitor id,
and selected entities. With `--state-file`, you provide the exact path. With
neither flag, `gh-delta` uses a per-user temp directory and reports the resolved
path in the output.

Exact path derivation, filename encoding, default monitor-id behavior, and
snapshot shape are specified in [Snapshot Semantics](../contract/snapshots.md#snapshot-semantics).

## Listing Monitors

`gh-delta list` answers "which monitors have run on this machine, and when?"
without touching anything: it reports each monitor's repo, monitor id,
entities, last run, and stored object counts. It never contacts GitHub and
never creates, updates, or deletes snapshots, so it is safe to run while
monitors tick.

```bash
gh-delta list --format text
```

With no flags the inventory is global. Every successful detector run leaves a
tiny breadcrumb in a per-user [run registry](../contract/registry.md#run-registry)
(disable with `--no-registry` or `GH_DELTA_NO_REGISTRY=1`), so monitors appear
no matter which `--state-dir` or `--state-file` they use. The registry is an
index, not state: deleting it is always safe and it rebuilds as monitors run.

Add `--since` to keep only monitors that ran recently, or `--state-dir` to
narrow the inventory to one directory:

```bash
gh-delta list --since 24h --format text
gh-delta list --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --format text
```

A corrupt snapshot shows up as an entry with an error, and a registered
monitor whose snapshot was deleted shows up flagged `stale`, so `list` doubles
as a quick health check. The exact flags and report shape are specified in
[gh-delta list](../contract/list.md#gh-delta-list).
