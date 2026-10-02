# Scheduler Choices

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

The scheduler-specific claims below (Claude Code, Codex, and ChatGPT behavior)
were verified against vendor docs on 2026-07-12. Re-verify before relying on
them if this section is significantly older than the vendor's current release.

## Plain Cron Or Equivalent

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
