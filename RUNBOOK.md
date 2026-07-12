# gh-delta Watch Loop Runbook

`gh-delta` is only the detector. It compares GitHub state with a local snapshot,
prints JSON or operator text, and exits with a machine-readable code. The caller
owns the clock.

The safest default is a cron-native loop:

1. Seed the baseline once.
2. Create a recurring scheduler outside the tick.
3. Each scheduled fire runs one self-contained `gh-delta` command.
4. The tick never rearms itself.

This avoids double-scheduling and avoids assuming a runtime-specific wake-up API
such as `ScheduleWakeup`.

## Requirements

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
  --state-dir ./state \
  --entities pr,issue \
  --format json
```

The first successful run should return a report with `"baseline": true` and exit
`0`. That is normal. It seeds the snapshot so the first scheduled tick compares
against known state instead of reporting every existing issue or PR as new.

To audit which monitors already exist on a machine — before adding one, or when
inheriting a host — run the read-only inventory:

```bash
gh-delta list --format text
```

It reports each monitor's repo, id, entities, and last run from the
[run registry](docs/contract.md#run-registry) plus the temp default location,
flags registered monitors whose snapshot is gone as `stale`, and never touches
snapshots, so it is safe alongside live ticks. `--since 24h` shows only
recently active monitors.

## Cron-Native Tick

Each scheduled tick should run the detector and then stop. The scheduler already
owns the next fire.

The detector uses at-most-once delivery semantics: a successful detection writes
the new snapshot before the agent acts on the printed deltas. Persist the tick
output in scheduler logs before taking action. If you need at-least-once action
delivery, wrap `gh-delta` with an external queue or acknowledgement layer.

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
  --state-dir ./state \
  --entities pr,issue \
  --format text
```

Optional outpost command:

```bash
gh-delta \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir ./state \
  --entities pr,issue \
  --format text \
  --outpost-url https://example.com/gh-delta
```

Exit codes: see [Exit Codes](docs/contract.md#exit-codes). On `10`, act on each
listed delta; on `1` (transient), log the error and let the next scheduled fire
retry automatically; on `2` (permanent), stop the loop and alert the operator —
the configuration or snapshot must be fixed by a human before retrying.

Heartbeat format:

```text
<timestamp> | <N> delta(s)
```

Use `--format json` when another program needs the raw structured report.

## Outpost Mode

`--outpost-url` must be an `http:` or `https:` URL. Invalid configuration exits
`2` (permanent) before GitHub is fetched.

When the detector exits `10`, `gh-delta` sends one JSON `POST` per delta with
`Content-Type: application/json`. It does not POST on exit `0`, `1`, or `2`.
POST failure, timeout, DNS failure, `4xx`, or `5xx` prints an `outpost warning`
but does not change the detector result.

Payloads use schema v1: see [Outpost payload schema v1](docs/contract.md#outpost-payload-schema-v1) for the full envelope.

Outpost is best-effort notification. `eventId` is the semantic dedupe key and
`deliveryId` identifies one delivery attempt. `gh-delta` does not provide
reliable delivery, retries, an outbox, acknowledgement, or replay while
`report.schemaVersion === 1`. The endpoint owns filtering, deduplication by
`eventId`, and any downstream action. Do not put secrets in the outpost URL. If
authentication is added later, headers or tokens must not be printed in logs.

## Semantic Summaries

Add `--summaries` to attach a normalized, typed `summary` object to every PR
delta that has a current object. It is derived from the same single observation
as the opaque fingerprints — no second GitHub call — and is a sibling of `to`, so
the content-addressed `delta.id` and every existing field stay byte-identical
whether or not the flag is set. Fields, enum domains, and honesty semantics
(`ciRollup: none` for zero checks, `mergeable: unknown` for not-yet-computed) are
specified in [Delta Summary schema](docs/contract.md#delta-summary-schema).

Live acceptance check (proves the load-bearing `ciRollup` end to end against real
GitHub, using a scratch PR you own):

```bash
STATE=$(mktemp -d)
REPO=you/scratch          # a repo with NO required checks on the PR's base
PR=1                      # an open PR whose head has no commit status yet

# 1. Seed a baseline while the PR has zero checks.
gh-delta --repo "$REPO" --monitor-id acc --state-dir "$STATE" --entities pr --summaries

# 2. Post a successful commit status on the PR head and re-run.
HEAD=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)
gh api "repos/$REPO/statuses/$HEAD" -f state=success -f context=acceptance >/dev/null
gh-delta --repo "$REPO" --monitor-id acc --state-dir "$STATE" --entities pr --summaries \
  | jq '.deltas[] | select(.classes | index("ci-changed")) | .summary.ciRollup'
# expect: "green"   (and a fresh baseline against the zero-check PR reports "none")
```

## Scheduler Choices

The scheduler-specific claims below (Claude Code, Codex, and ChatGPT behavior)
were verified against vendor docs on 2026-07-12. Re-verify before relying on
them if this section is significantly older than the vendor's current release.

### Plain Cron Or Equivalent

Use cron, launchd, systemd timers, or GitHub Actions when the watcher should be
owned by infrastructure outside the agent session. The scheduler invokes the
tick prompt or wrapper at a fixed cadence.

### Claude Code Session Scheduling

Claude Code documents `/loop` and session-scoped scheduled tasks for local
polling. `/loop 5m <prompt>` creates a fixed-interval task. `/loop <prompt>`
lets Claude choose the delay between iterations where supported.

Under the documented task-management layer, Claude Code uses `CronCreate`,
`CronList`, and `CronDelete` for session tasks. A cron-owned tick prompt should
not call `ScheduleWakeup` and should not create a second cron. Recurring
session-scoped tasks expire after seven days.

`ScheduleWakeup` is not a general-purpose scheduler. It is tied to dynamic
`/loop` self-pacing, and Claude Code's subagent documentation explicitly lists it
among the tools that are not available to subagents. If a watcher tick is
running inside a subagent, assume it cannot self-rearm with `ScheduleWakeup`;
create the session cron from the main conversation or use `/loop` before
delegating work.

### Claude Code Cloud Routines

Use `/schedule` or the Claude web UI for durable routines on Anthropic-managed
infrastructure. These are better when the work should continue while your local
machine or terminal is closed.

### Codex Automations

Use a Codex thread heartbeat automation when the watcher should return to the
same thread. Use a cron/project automation when each run should be independent
or should run in a local/worktree project context.

### ChatGPT Scheduled Tasks

ChatGPT Scheduled Tasks are suitable for reminders, recurring check-ins, and
monitoring tasks with notifications. They are not a replacement for sub-hour
developer polling loops or webhook-driven automation.

## Delta Classes

| class                         | typical orchestrator action                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new` (PR)                    | a worker opened a PR; read it and queue review                                                                                                                    |
| `first-seen`                  | first observed non-open item; inspect it before treating it as newly created                                                                                      |
| `ci-changed`                  | CI green: consider merge path; CI red: nudge worker with the failure (with `--format json --detail`, the delta's `ci` detail names the exact checks that changed) |
| `review-changed`              | approved: merge candidate; changes requested: relay to worker (with `--format json --detail`, the `reviews` detail names the reviewers and state transitions)     |
| `became-mergeable`            | conflicts resolved; merge candidate                                                                                                                               |
| `draft-ready`                 | PR left draft and is ready for review; queue it for review or dispatch                                                                                            |
| `merged` / `closed`           | slice done; advance build order or sync spawn base                                                                                                                |
| `reopened`                    | item reopened; re-enter it into the active work queue                                                                                                             |
| `new-comments`                | read PR threads; fold review comments before merge                                                                                                                |
| `unresolved-threads-added`    | unresolved review threads appeared; resolve before merge                                                                                                          |
| `unresolved-threads-resolved` | review threads resolved; re-check CI and review state                                                                                                             |
| `review-threads-changed`      | review thread activity changed; inspect before acting                                                                                                             |
| `relabeled`                   | scope or state change on an issue; reassess dispatch                                                                                                              |
| `missing`                     | open item disappeared from fetch; check pagination, permissions, or scope                                                                                         |
| `still-missing`               | open item remains absent (tick 2); unresolved operational issue, not a fresh delta                                                                                |
| `presumed-deleted`            | absent for 3 consecutive ticks; treat as gone; verify on GitHub if unexpected; no further ticks will mention it unless it reappears                               |
| `updated`                     | catch-all (`updatedAt` or head-only); inspect GitHub before dismissing                                                                                            |
| `reappeared`                  | object returned after prior `missing`; check why it vanished before acting                                                                                        |

## Operating Rules

- Do not edit snapshot files by hand. The tool owns them.
- Keep scheduler logs for tick output. A delta is acknowledged by snapshot
  advancement before any downstream action completes.
- If using `--outpost-url`, make the endpoint idempotent and deduplicate by
  `eventId`; `gh-delta` does not retry or persist failed sends.
- Do not call `ScheduleWakeup` from a cron-owned tick.
- Do not call `ScheduleWakeup` from a subagent-owned tick; Claude Code does not
  expose it to subagents.
- Do not create another cron from inside a cron-owned tick.
- Do not run overlapping ticks against the same state file. If your scheduler
  can overlap jobs, add external locking or increase the interval. This rule is
  also exposed in `gh-delta --help-json` as `stateConcurrency` for agent and
  scheduler tooling.
- If the command exits `1` with "exceeded N pages — narrow the monitor scope or
  re-seed the baseline", do exactly that before continuing. The tool fails closed
  rather than silently truncating. Open items are capped at 1 000 per family;
  updated items per tick are capped at 3 000. Repeated occurrences of this exit
  on consecutive ticks are an operator-action signal — narrow the scope or
  re-seed; this is not a transient error to retry indefinitely.
- Do not merge a PR blind on green CI alone. Read review comments first.
- If the same delta refires every tick, stop and investigate instead of acting
  repeatedly.
- If you need a different cadence, update the scheduler outside the tick. For
  session-scoped Claude Code crons, that means delete and recreate the cron.
