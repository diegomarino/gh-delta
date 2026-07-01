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

## Seed The Baseline

Run the detector once before creating the recurring job:

```bash
node ./gh-delta.mjs \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir ./state \
  --entities pr,issue \
  --format json
```

The first successful run should return a report with `"baseline": true` and exit
`0`. That is normal. It seeds the snapshot so the first scheduled tick compares
against known state instead of reporting every existing issue or PR as new.

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
5. Stop this tick.

Tick command:

```bash
node ./gh-delta.mjs \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir ./state \
  --entities pr,issue \
  --format text
```

Optional outpost command:

```bash
node ./gh-delta.mjs \
  --repo <owner/name> \
  --monitor-id <stable-monitor-id> \
  --state-dir ./state \
  --entities pr,issue \
  --format text \
  --outpost-url https://example.com/gh-delta
```

Exit codes:

- `0`: baseline established or no change since the last check. Report the
  printed heartbeat and stop.
- `10`: deltas found. Read the printed delta list, act on each delta, and stop.
- `1`: argument, `gh`, network, or parse error. The snapshot was not updated.
  Log the error and stop; the next scheduled fire retries.

Heartbeat format:

```text
<timestamp> | <N> delta(s)
```

Use `--format json` when another program needs the raw structured report.

## Outpost Mode

`--outpost-url` must be an `http:` or `https:` URL. Invalid configuration exits
`1` before GitHub is fetched.

When the detector exits `10`, `gh-delta` sends one JSON `POST` per delta with
`Content-Type: application/json`. It does not POST on exit `0` or `1`. POST
failure, timeout, DNS failure, `4xx`, or `5xx` prints an `outpost warning` but
does not change the detector result.

Payloads use schema v1:

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:prs-5m:issue:17:relabeled:2026-07-01T12:00:00.000Z",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "detectedAt": "2026-07-01T12:00:00.000Z",
  "entity": "issue",
  "number": 17,
  "title": "Backfill imports",
  "classes": ["relabeled"],
  "state": "OPEN",
  "labels": ["worker", "backend"],
  "line": "ISSUE #17 \"Backfill imports\": relabeled",
  "delta": {
    "from": {},
    "to": {}
  },
  "links": {
    "html": "https://github.com/owner/repo/issues/17"
  }
}
```

The endpoint owns filtering, deduplication by `eventId`, and any downstream
action. Do not put secrets in the outpost URL. If authentication is added later,
headers or tokens must not be printed in logs.

## Scheduler Choices

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

| class                         | typical orchestrator action                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `new` (PR)                    | a worker opened a PR; read it and queue review                                  |
| `ci-changed`                  | CI green: consider merge path; CI red: nudge worker with the failure            |
| `review-changed`              | approved: merge candidate; changes requested: relay to worker                   |
| `became-mergeable`            | conflicts resolved; merge candidate                                             |
| `merged` / `closed`           | slice done; advance build order or sync spawn base                              |
| `new-comments`                | read PR threads; fold review comments before merge                              |
| `unresolved-threads-added`    | unresolved review threads appeared; resolve before merge                        |
| `unresolved-threads-resolved` | review threads resolved; re-check CI and review state                           |
| `review-threads-changed`      | review thread activity changed; inspect before acting                           |
| `relabeled`                   | scope or state change on an issue; reassess dispatch                            |
| `missing`                     | previous object disappeared from fetch; check pagination, permissions, or scope |
| `still-missing`               | object remains absent; unresolved operational issue, not a fresh delta          |
| `updated`                     | catch-all (`updatedAt` or head-only); inspect GitHub before dismissing          |

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
  can overlap jobs, add external locking or increase the interval.
- If the command reports that GitHub returned 500 PRs/issues or incomplete
  paginated review threads, narrow the monitor scope before continuing. The tool
  fails closed rather than silently truncating.
- Do not merge a PR blind on green CI alone. Read review comments first.
- If the same delta refires every tick, stop and investigate instead of acting
  repeatedly.
- If you need a different cadence, update the scheduler outside the tick. For
  session-scoped Claude Code crons, that means delete and recreate the cron.
