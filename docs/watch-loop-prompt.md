# Cron-Native Watch Tick Prompt

Use this prompt when the scheduler already owns the clock. Each fire is a fresh
tick. The prompt is deliberately stateless and does not rearm itself.

Replace the placeholders before scheduling it.

```text
[gh-delta watch tick -- fired by cron; the cron owns the schedule, do NOT rearm]

Run the GitHub delta detector for `<owner/name>` and act on what it reports.

1. Run exactly this:
   gh-delta \
     --repo <owner/name> \
     --monitor-id <stable-monitor-id> \
     --state-dir ./state \
     --entities pr,issue \
     --format text

2. Read its exit code:
   - 0  = baseline seeded or no change. Report the printed heartbeat and STOP
          this tick.
   - 10 = deltas present. The output lists each delta and a suggested action.
          For EACH delta, decide the real action, note what you did, and STOP
          this tick.
   - 1  = argument, GitHub CLI, network, or parse error. The report has an
          error section and the snapshot was NOT touched. Log it and STOP this
          tick. The next cron fire retries.

   A baseline message means the snapshot was just seeded with no deltas. That is
   normal, not an error.

3. Delta class -> action:
   - new (PR): a worker opened a PR. Read it; queue it for review.
   - ci-changed: CI green -> move toward merge. CI red -> nudge the worker with
     the failure.
   - review-changed: APPROVED -> merge candidate. CHANGES_REQUESTED -> relay the
     changes to the worker.
   - became-mergeable: conflicts resolved -> merge candidate.
   - merged / closed: a slice is done. Advance the build order or sync the spawn
     base.
   - new-comments: read the PR/issue threads; fold in any review comments before
     merging.
   - unresolved-threads-added: unresolved PR review threads appeared. Read and
     resolve them before merging.
   - unresolved-threads-resolved: unresolved PR review threads were resolved.
     Re-check CI and review state before merging.
   - review-threads-changed: PR review thread activity changed. Inspect review
     threads before acting.
   - relabeled: an issue's scope/state changed. Reassess whether or what to
     dispatch.
   - missing: a previously known object disappeared from the fetch. Check
     pagination, permissions, or scope before trusting the snapshot.
   - still-missing: the same object is still absent. Treat it as unresolved
     operational state, not a fresh item.
   - reappeared: a previously missing object returned. Check why it vanished
     before acting on the return.
   - updated: catch-all timestamp or commit-only bump. Inspect GitHub before
     dismissing it, including comments and review threads.

Rules:
- Do NOT call ScheduleWakeup.
- Do NOT create another cron.
- This tick is already scheduled by the existing cron.
- Ensure this tick's output is preserved in scheduler logs before taking action;
  successful detection advances the snapshot before downstream action completes.
- If this prompt is running inside a Claude Code subagent, remember that
  ScheduleWakeup is not available to subagents. Treat the existing cron as the
  only clock owner.
- Never edit the tool or its state files by hand.
- Do not run overlapping ticks against the same state file.
- Do not merge a PR blind on green CI alone. Read review comments first and fold
  in anything with merit before merging.
- If the same delta keeps refiring every tick, stop and report it instead of
  acting on it repeatedly.
- If the command reports that GitHub returned 500 PRs/issues or incomplete
  paginated review threads, narrow the monitor scope before continuing.
```

## Setup Sequence

1. Seed the baseline once:

   ```bash
   gh-delta \
     --repo <owner/name> \
     --monitor-id <stable-monitor-id> \
     --state-dir ./state \
     --entities pr,issue \
     --format json
   ```

2. Create the scheduler with the prompt above.

For Claude Code session scheduling, use `/loop <interval> <prompt>` or create a
session cron through the documented scheduled-task mechanism. The cron prompt
must stay self-contained because each fire is a fresh turn.

For Codex, use a thread heartbeat automation when the watcher should preserve
this thread's context, or a cron/project automation when each run should be
independent.
