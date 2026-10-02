# Pattern 2: wait for one PR condition

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

Persist the target once, then let `wait` perform targeted observations until a
semantic condition is true or the timeout expires:

```bash
PR_NUMBER=42

gh-delta watch add "pr:$PR_NUMBER" \
  --repo "$REPO" --watch-dir "$WATCH_DIR" --until merged --format text

gh-delta watch add "pr:$PR_NUMBER" \
  --repo "$REPO" --watch-dir "$WATCH_DIR" --until merged \
  --label thread=t-0004 --label package=F001-P05 --format text

Labels are local routing context stored on the watch entry and copied onto
emitted deltas. They are not proof of task ownership.

gh-delta wait \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --watch-dir "$WATCH_DIR" \
  --entities pr \
  --timeout 30m \
  --interval 60s \
  --max-interval 60s \
  --backoff 1 \
  --until-summary ciRollup=green,failed \
  --progress
```

On exit `10`, inspect `reason` and the returned `deltas[].summary`, matching
the target repository and item. The deltas accumulate across the wait, so
earlier entries can describe earlier states. The public `wait` report does
not expose `lastReport`.

An `already-satisfied` result can have an empty `deltas` array: the condition
may have matched the snapshot on the first tick. To inspect the open PR's
locally observed state, use the same monitor and watch scope:

```bash
gh-delta status \
  --repo "$REPO" --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" --watch-dir "$WATCH_DIR" \
  --entities pr --format json
```

Read the matching `items[].summary`. `status` lists only open items; for a
closed or merged PR, inspect `pr["42"].fingerprint` (substituting the target
number) in the snapshot named by its `stateFile`. This is the latest local
observation, not a new GitHub fetch. Exit `0` from `wait` means timeout/signal,
not success. This workflow observes only; it does not authorize merge or
review actions.
