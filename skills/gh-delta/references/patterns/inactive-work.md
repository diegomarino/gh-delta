# Pattern 5: find inactive work

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

Generate inactivity deltas during normal ticks, then inspect local state without
another GitHub request:

```bash
gh-delta \
  --repo "$REPO" --monitor-id "$MONITOR_ID" --state-dir "$STATE_DIR" \
  --entities pr --stale-after 7d --format compact

gh-delta status \
  --repo "$REPO" --monitor-id "$MONITOR_ID" --state-dir "$STATE_DIR" \
  --entities pr --format text
```

Do not add `status --refresh` unless a fresh detector tick is intentional.
