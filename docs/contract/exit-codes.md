# Exit Codes

[Documentation](../README.md) · [Contract reference](../contract.md)

- `0`: baseline established, no deltas, or no surviving deltas after attention
  filtering.
- `10`: deltas found. Also emitted when `--baseline-emit-state` seeds a baseline
  that observes at least one tracked open item: the report then carries
  `results[].baseline: true` **and** a non-empty `deltas` array of
  `baseline-state` deltas. Watchers that chain on exit `10` feed this baseline
  report like any other.
- `1`: **transient error** — GitHub CLI, network, timeout, snapshot write
  failure, or a busy state-file lock (`kind: "busy"`, see
  [Lock Semantics](locks.md#lock-semantics)). The snapshot is not updated; the next
  scheduled tick should retry automatically.
- `2`: **permanent error** — invalid configuration or unreadable / invalid-shape
  / pre-schema-v2 snapshot. Retrying will not help; a human must fix the issue
  before the next tick (see [`gh-delta reset`](reset.md#gh-delta-reset)).
