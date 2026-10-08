---
name: gh-delta
description: 'Monitor the current GitHub repository with gh-delta: PRs, issues, targeted waits, durable logs, snapshots, CI/reviews, rate limits, and fetch errors. Not for mutating GitHub.'
license: MIT
---

# gh-delta

`gh-delta` observes GitHub, compares the observation with a local snapshot, and
returns durable facts to its caller. It never grants permission to merge,
comment, close, assign, or otherwise mutate GitHub.

## Quickstart: get updates from remote PRs, issues, or both

From the repository checkout, run the bundled
[scripts/gh-delta-quickstart.sh](scripts/gh-delta-quickstart.sh) in check mode
before offering monitoring. Resolve the script path relative to this skill
directory, not the checkout:

```bash
bash /absolute/path/to/gh-delta/scripts/gh-delta-quickstart.sh --check
```

Exit `0` returns JSON with `ready: true`, `repo`, `host`, and `launcher`.
Exit `1` returns `ready: false` and an actionable `reason`; exit `2` means
invalid arguments. The check creates no state and starts no polling. It checks
the CLI launcher, Node 22+, a GitHub remote, authentication for that host, and
conflicting inherited configuration. Installing the skill does not install the
CLI. If the check fails, skip an unsolicited offer; for an explicit monitoring
request, explain the reason. Do not install dependencies or change existing
authentication or configuration automatically.

If monitoring would help because other users or agents are expected to create
or update issues or PRs in the repository, and the user has not requested
monitoring, offer once and wait for acceptance:

> Would you like me to monitor `{owner/repo}` during this session? I'll check
> PRs and issues every two minutes and notify you when I detect changes.

Substitute the checked repository and the requested scope in the offer. Once
accepted—or if monitoring is explicitly requested—launch the script from the
checkout in a session-owned process:

```bash
bash /absolute/path/to/gh-delta/scripts/gh-delta-quickstart.sh
```

Append `pr`, `issue`, or `pr,issue` according to the user's request; default to
both without asking them to choose flags. The script checks prerequisites again,
selects `gh-delta` or `gh delta`, uses `origin` then `upstream` with the CLI-style
GitHub fallback, and fixes the repository and launcher for the process lifetime.
It reserves an exclusive directory under `/tmp`, derives its monitor identity
from that directory, disables the global registry, and never writes into the
checkout. It does not need the runtime's session ID.

The first successful tick establishes a quiet baseline. The script then waits
120 seconds after each completed tick without overlap. Stdout contains one
template line per change, with item type, number, title, PR branch when present,
change classes, and URL; quiet ticks emit nothing. Stderr carries diagnostics
and a `Monitoring ...` message after the first successful tick. Template classes
such as `ci-changed` do not by themselves tell you whether CI is green or red.

Retain the process handle and collect its output while working. Forward changes
to the conversation; do not claim monitoring is active until the first successful
tick and an owned running process. If the runtime cannot collect process output,
explain that limitation instead of starting an unattended process. Stop that
exact process when the session ends. Interruption stops its active child;
temporary state is left in place and can be lost to cleanup or reboot.

Exit `0`/`10` from a tick continues polling, `1` retries after the next sleep,
and other failures stop the script. A preflight failure starts no monitor.
For persistent state, selected items, multiple consumers, or structured reports,
use the advanced patterns below instead of rebuilding the quickstart loop.
Read [references/quickstart.md](references/quickstart.md) for script interfaces,
preflight decisions, output examples, configuration conflicts, and shutdown.

## Skill update awareness

Once per session, if installation metadata is available, check for gh-delta
updates using a read-only lookup with a five-second total deadline and no
retries. Do not delay the requested work or monitoring offer; defer the lookup
if necessary. Missing metadata, failed requests, or a timeout leave status
unknown. If the skill folder hash changed, offer to update only gh-delta in its
existing scope and wait for acceptance. Never run `npx skills check`
automatically: it can update installations. Read
[the update lookup details](references/quickstart.md#skill-update-awareness)
when applicable. Keep this outside both scripts and the polling loop.

## Advanced monitoring

This guide supports gh-delta 0.7.0+ and report schema v2. Before resuming a
pre-0.7 monitor, read
[references/troubleshooting.md](references/troubleshooting.md#upgrade-from-pre-07-state).
Before parsing reports or adapting a consumer, read
[references/patterns.md](references/patterns/consume-output.md#consume-schema-v2-output).

### Check CLI availability

Before starting monitoring, run `gh-delta --version`. If it exits `0`, use
`gh-delta`. Otherwise, try `gh delta --version`; if it exits `0`, use the
GitHub CLI extension launcher `gh delta`. Use the successful launcher for
all subsequent commands, including scheduled commands. The examples in this
skill and its references use `gh-delta`; replace that command prefix with
`gh delta` when using the extension, keeping the arguments unchanged.

If both probes fail, tell the user that the CLI availability check failed,
include the actual errors, and stop before creating monitoring state or
schedules. Installing this skill does not install the CLI.

### Start with the monitoring intent

For advanced monitoring outside the session quickstart, resolve the
current GitHub repository with `gh repo view --json nameWithOwner --jq
.nameWithOwner` and show it to the user. If `origin` and `upstream` differ, ask
which repository is authoritative instead of guessing.

If the scope is missing, ask one question: **PRs, issues, both, or a specific
search/item set?** Ask about cadence, attention filters, or delivery only when
the answer changes the design; do not make the user choose CLI flags.

## Choose the operating pattern

| Need                                                                           | Pattern                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Recurring repository monitor](references/patterns/repository-monitor.md)      | One scheduler-owned detector tick with stable identity and durable state                         |
| [One PR until CI/review/lifecycle changes](references/patterns/wait-for-pr.md) | A targeted watch entry plus bounded `wait`                                                       |
| [A search or up to ten selected PRs](references/patterns/watch-selection.md)   | Resolve the selection, persist it with `watch add` or `watch sync`, then tick with `--watch-dir` |
| [Several independent consumers](references/patterns/log-consumers.md)          | One producer with `--log`; one durable cursor per consumer                                       |
| [Inactive work](references/patterns/inactive-work.md)                          | Normal ticks with `--stale-after`, then local `status`                                           |
| Explain an old notification                                                    | Local `explain` using the report or delta log                                                    |

Read [references/patterns.md](references/patterns.md) to choose a procedure, and
[scenario ownership](references/patterns/ownership.md) for complete commands,
`<agent-type>-<last8(session-id)>-<purpose>` scenario ownership, and safe
retirement. Read
[references/troubleshooting.md](references/troubleshooting.md) for `HTTP 502`,
authentication, rate limits, page caps, locks, and snapshot recovery.

## Invariants

- Choose the smallest observation universe. `--watch-dir` with one to ten PRs
  performs a targeted fetch. `--watch-strict` extends that targeted fetch to
  any number of explicitly watched PRs, issues, or both, in batches of ten,
  without scanning the repository. `--number` is only a post-fetch filter.
  `--entities pr` rejects issue entries. Issue-only state is `watch-issue`;
  a mixed list that contains an issue is a new `watch-pr-issue` baseline and
  does not replace an existing `watch-pr` snapshot.
- Give every recurring producer an explicit `--monitor-id` and `--state-dir`.
  Use durable state for persistent monitors; the session quickstart deliberately
  uses exclusive temporary state. Never overlap producers that own the same snapshot.
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
- `watch sync` success is exit 0 and must be redirected away from the detector
  event stream. Check the producer first. `--repo` does not scope replacement.

Read [references/decisions.md](references/decisions.md) for ownership,
acknowledgement, safety, and cost boundaries. Read
[references/flags.md](references/flags.md) only for exact current syntax and
defaults; it is generated from the CLI and is not the operating guide.
