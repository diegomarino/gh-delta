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

Read the page for your task. The links below also preserve earlier section bookmarks.

- <a id="requirements"></a>[Requirements](docs/operations/baseline.md#requirements)
- <a id="seed-the-baseline"></a>[Seed The Baseline](docs/operations/baseline.md#seed-the-baseline)
- <a id="cron-native-tick"></a>[Cron-Native Tick](docs/operations/scheduled-tick.md#cron-native-tick)
- <a id="outpost-mode"></a>[Outpost Mode](docs/operations/outpost.md#outpost-mode)
- <a id="delta-summaries"></a>[Delta Summaries](docs/operations/delta-summary.md#delta-summaries)
- <a id="scheduler-choices"></a>[Scheduler Choices](docs/operations/schedulers.md#scheduler-choices)
- <a id="plain-cron-or-equivalent"></a>[Plain Cron Or Equivalent](docs/operations/schedulers.md#plain-cron-or-equivalent)
- <a id="claude-code-session-scheduling"></a>[Claude Code Session Scheduling](docs/operations/schedulers.md#claude-code-session-scheduling)
- <a id="claude-code-cloud-routines"></a>[Claude Code Cloud Routines](docs/operations/schedulers.md#claude-code-cloud-routines)
- <a id="codex-automations"></a>[Codex Automations](docs/operations/schedulers.md#codex-automations)
- <a id="chatgpt-scheduled-tasks"></a>[ChatGPT Scheduled Tasks](docs/operations/schedulers.md#chatgpt-scheduled-tasks)
- <a id="delta-classes"></a>[Delta Classes](docs/operations/delta-actions.md#delta-classes)
- <a id="operating-rules"></a>[Operating Rules](docs/operations/operating-rules.md#operating-rules)
