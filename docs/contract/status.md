# gh-delta status

[Documentation](../README.md) · [Contract reference](../contract.md)

`gh-delta status [--number <numbers>] [--watch-dir <path>] [--refresh]` reads
the monitor snapshot and returns each selected open PR or issue with persisted
`lastChangedAt` and `ticksSinceChange`; PRs also carry their normalized
`summary` (issues have `summary: null`). Without `--refresh` it performs no
GitHub call and writes nothing. `--refresh` performs exactly one normal detector
tick before the local read, while the final status command still exits `0` on
success. A refresh preserves existing stale bookkeeping for unchanged items; a
real fingerprint change resets it. `--number` filters every returned entity. With `--watch-dir`, a local
0-10 PR-only watch universe reads the detector's separate economical watch
snapshot. `--watch-strict` reads `watch-pr`, `watch-issue`, or `watch-pr-issue`
for that same selection. `--refresh` then reads the snapshot file that tick
published, so a terminal cleanup that changes the strict universe does not
redirect the local read. Every other watch list uses the normal snapshot. `text` renders the same
returned items as the JSON report.

`--stale-after <duration>` uses the shared duration grammar. An open item whose
fingerprint has not changed past that threshold emits `stale` once per UTC-day
period. The snapshot persists `staleEmittedFor` outside the compared fingerprint
and clears it on a real change; `staleAt` is included in the stale delta identity
so distinct periods have distinct ids.
