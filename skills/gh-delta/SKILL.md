---
name: gh-delta
description: 'Monitor the current GitHub repository with gh-delta: PRs, issues, targeted waits, durable logs, snapshots, CI/reviews, rate limits, and fetch errors. Not for mutating GitHub.'
license: MIT
---

# gh-delta

`gh-delta` observes GitHub, compares the observation with a local snapshot, and
returns durable facts to its caller. It never grants permission to merge,
comment, close, assign, or otherwise mutate GitHub.

This guide targets gh-delta 0.7.0 and report schema v2. Before resuming a
pre-0.7 monitor, read
[references/troubleshooting.md](references/troubleshooting.md#upgrade-from-pre-07-state).
Before parsing reports or adapting a consumer, read
[references/patterns.md](references/patterns.md#consume-schema-v2-output).

## Start with the monitoring intent

For the usual request—“monitor the repository I am working in”—resolve the
current GitHub repository with `gh repo view --json nameWithOwner --jq
.nameWithOwner` and show it to the user. If `origin` and `upstream` differ, ask
which repository is authoritative instead of guessing.

If the scope is missing, ask one question: **PRs, issues, both, or a specific
search/item set?** Ask about cadence, attention filters, or delivery only when
the answer changes the design; do not make the user choose CLI flags.

## Choose the operating pattern

| Need                                     | Pattern                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Recurring repository monitor             | One scheduler-owned detector tick with stable identity and durable state         |
| One PR until CI/review/lifecycle changes | A targeted watch entry plus bounded `wait`                                       |
| A search or up to ten selected PRs       | Resolve the selection, persist it with `watch add`, then tick with `--watch-dir` |
| Several independent consumers            | One producer with `--log`; one durable cursor per consumer                       |
| Inactive work                            | Normal ticks with `--stale-after`, then local `status`                           |
| Explain an old notification              | Local `explain` using the report or delta log                                    |

Read [references/patterns.md](references/patterns.md) for complete commands,
`<agent-type>-<last8(session-id)>-<purpose>` scenario ownership, and safe
retirement. Read
[references/troubleshooting.md](references/troubleshooting.md) for `HTTP 502`,
authentication, rate limits, page caps, locks, and snapshot recovery.

## Invariants

- Choose the smallest observation universe. `--watch-dir` with one to ten PRs
  performs a targeted fetch; `--number` is only a post-fetch filter.
- Give every recurring producer an explicit `--monitor-id` and durable
  `--state-dir`. Never overlap producers that own the same snapshot.
- The first successful tick normally establishes a quiet baseline. Do not call
  pre-existing work new; use `--baseline-emit-state` only when that distinction
  is understood.
- Branch on exit code before parsing output. For `wait`: `10`
  until/already-satisfied, `0` timeout/signal, `1` retryable failure, `2` fix
  configuration. A failed repository tick does not advance that repository's
  snapshot; a multi-repository run can still publish successful repositories.
- For ordinary detector output use `compact` for bounded agent context,
  `ndjson` for streams, JSON for the full integration contract, and `text` for
  operator logs. `wait` accepts JSON only.
- A log consumer advances its cursor only after durable handling. Deduplicate
  external actions by `delta.id`, not log sequence.

Read [references/decisions.md](references/decisions.md) for ownership,
acknowledgement, safety, and cost boundaries. Read
[references/flags.md](references/flags.md) only for exact current syntax and
defaults; it is generated from the CLI and is not the operating guide.
