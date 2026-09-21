---
name: gh-delta
description: 'Decide how to monitor GitHub PRs and issues with gh-delta: wait for a condition, replay a delta, diagnose CI, or find inactive work. Not for mutating GitHub.'
license: MIT
---

# gh-delta

Use `gh-delta` to observe GitHub state, then make the decision in the caller.
It does not merge, comment, assign, or otherwise mutate GitHub.

Choose the smallest read path:

- A newly opened PR: use `wait --timeout <duration> --until-summary <field=value>` when a worker should stop at a semantic condition. Branch on exit code before parsing output: `10` until/already-satisfied, `0` timeout/signal, `1` retryable failure, `2` fix configuration.
- A requested change: use `read --cursor <path> --number <n>` to replay only that item, then inspect it with `gh pr view <n>`. Advance a cursor only after the consumer has durably handled the delta.
- Red CI or review uncertainty: run one detector tick with `--detail` and read structured `details`; use a `detailsUrl` only as a link to inspect, never as permission to act.
- Work waiting too long: enable `--stale-after <duration>` on normal detector ticks, then use `status` for the local item summary. `status` is local-only unless `--refresh` is explicit.

For ordinary detector output, use `--format compact` or `ndjson` for an agent consumer; use `text` only for operator logs. `wait` accepts JSON only.

Read [references/flags.md](references/flags.md) for exact syntax and defaults.
Read [references/decisions.md](references/decisions.md) when choosing a worker/cursor/snapshot topology or interpreting safety boundaries.
