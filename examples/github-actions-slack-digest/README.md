# GitHub Actions → Slack digest

A watcher with **no machine of your own**: GitHub Actions owns the clock, an
`actions/cache` entry owns the snapshot, and deltas land in a Slack channel.

```
GitHub Actions schedule (every 15 min, concurrency-guarded)
   │
   ▼
actions/cache restore ── .gh-delta-state/ (snapshot from the last tick)
   │
   ▼
npx gh-delta --format json --detail ── one deterministic tick
   │            exit 10 = deltas
   ▼
jq digest ──> Slack incoming webhook ("gh-delta: 2 delta(s) in owner/repo …")
   │
   ▼
actions/cache save (if: always())
```

## Install

1. Copy `gh-delta-watch.yml` into the watched repo's `.github/workflows/`.
2. Create a Slack incoming webhook and store it as the `SLACK_WEBHOOK_URL`
   repository secret.
3. Push. The first run seeds the baseline (exit `0`, no Slack message).

## Design notes

- **Exit taxonomy in CI terms** — exit `10` posts the digest; exit `1`
  (transient) is a `::warning::` annotation and the next schedule retries;
  exit `2` (permanent config error) **fails the job** so it shows red instead
  of silently retrying a broken configuration forever. See
  [exit codes](../../docs/contract.md#exit-codes).
- **`--detail` is load-bearing**: the digest reads `.deltas[].line`, which is
  only present with `--detail`.
- **Cache as state, honestly**: `actions/cache` evicts entries after ~7 days
  without hits. If the restore misses, the tick re-seeds a baseline and any
  deltas in the gap were never observed — the workflow surfaces that as a
  `::notice::` annotation instead of hiding it.
- **Concurrency group**: two overlapping ticks would restore the same
  snapshot and both exit `10` for the same deltas — the group serializes them.

## Requirements

Nothing to install: `node`, `npx`, `gh`, and `jq` are preinstalled on
`ubuntu-latest` runners. `npx gh-delta` resolves once the package is published
to npm; until then, check out gh-delta in the workflow and call
`node <checkout>/gh-delta.mjs` instead.
