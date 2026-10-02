# Durable replay log

[Documentation](../README.md) · [Usage by task](../usage.md)

Add `--log` when more than one consumer needs durable replay after a detector
tick. The snapshot still advances normally, while each emitted post-filter delta
is appended, fsynced, and published through a sibling `.published.json` boundary
before snapshot publication. Consumers only see the manifest-published NDJSON
prefix and deduplicate by `delta.id`: a crash after append but before the snapshot
can replay an id at a later sequence.

```bash
gh-delta --repo owner/repo --monitor-id prs-5m --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --entities pr --log
gh-delta cursor set ./state/triage.cursor.json 0 --log-file ./state/log-owner%2Frepo__monitor-prs-5m__pr.ndjson
gh-delta read --cursor ./state/triage.cursor.json --advance --format text
```

`read` does not contact GitHub or touch snapshots. Without `--advance`, it
re-delivers matching deltas; with it, it moves the cursor to the published log
tail scanned, including entries its filters rejected. `--advance` and `cursor
set` serialize mutations of that one cursor and report busy if another mutator
holds `<cursor>.lock`; non-advancing reads remain parallel. See [Delta Log and
Cursors](../contract/logs-and-cursors.md#delta-log-and-cursors) for the cursor and crash contracts.

Retention is explicit and local-only. Compact the log derived from the same
producer identity; snapshots and consumer cursors are never changed:

```bash
gh-delta log compact --repo owner/repo --monitor-id prs-5m --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --entities pr --keep 7d
```

Branch on the process exit code before reading stdout. Exit `10` is the
delta-found signal, not a process failure. See [Exit Codes](../contract/exit-codes.md#exit-codes).
