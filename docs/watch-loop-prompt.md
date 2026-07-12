# Cron-Native Watch Tick Prompt

Use this prompt when the scheduler already owns the clock. Each fire is a fresh
tick. The prompt is deliberately stateless and does not rearm itself.

Replace the placeholders before scheduling it.

The command in step 1 uses `--format text` for readable scheduler logs. If the
acting agent should see exactly which checks or reviews changed without a
second GitHub query, schedule step 1 with `--format json --detail` instead: the
`ci`/`reviews` details then name the added/removed/changed entries (see
[the contract](contract.md#report-shape)). A detail marked `opaque: true`
cannot name the change — inspect GitHub in that case. Pick the format up front:
a tick advances the snapshot, so a re-run cannot recover the details.

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
   - 1  = transient error (GitHub CLI, network, timeout, or write failure). The
          report has an error section and the snapshot was NOT touched. Log it
          and STOP this tick. The next cron fire retries automatically.
   - 2  = permanent error (invalid configuration or unreadable snapshot). STOP
          the loop immediately and alert the operator. Retrying will not help;
          a human must fix the issue first.

   A baseline message means the snapshot was just seeded with no deltas. That is
   normal, not an error.

3. Delta class -> action:
   - new (PR): a worker opened a PR. Read it; queue it for review.
   - first-seen: first observed non-open item. Inspect it before treating it as
     newly created.
   - ci-changed: CI green -> move toward merge. CI red -> nudge the worker with
     the failure.
   - review-changed: APPROVED -> merge candidate. CHANGES_REQUESTED -> relay the
     changes to the worker.
   - became-mergeable: conflicts resolved -> merge candidate.
   - draft-ready: PR left draft and is ready for review. Queue it for review or
     dispatch.
   - merged / closed: a slice is done. Advance the build order or sync the spawn
     base.
   - reopened: item reopened. Re-enter it into the active work queue.
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
   - missing: an open item disappeared from the fetch. Check pagination,
     permissions, or scope before trusting the snapshot.
   - still-missing: the same open item is still absent (tick 2). Treat it as
     unresolved operational state, not a fresh item.
   - presumed-deleted: absent for 3 consecutive ticks; treat as gone. Verify on
     GitHub if unexpected. No further ticks will mention it unless it reappears.
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
- If exit code is 2, stop the loop and alert a human. The configuration or
  snapshot must be fixed; retrying will not help.
- If the command exits 1 with "exceeded N pages", narrow the monitor scope or
  re-seed the baseline before continuing. The tool fails closed rather than
  silently truncating.
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
