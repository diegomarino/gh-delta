# Pattern 1: scheduler-owned repository monitor

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

For an ordinary session monitor, use the bundled
[quickstart](../../SKILL.md#quickstart-get-updates-from-remote-prs-issues-or-both).
Use this procedure for scheduler-owned monitoring with durable state; first read
[scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

Use one tick per scheduler invocation. The scheduler—not an LLM turn—owns the
cadence:

```bash
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --entities pr \
  --format compact
```

Choose `issue` or `pr,issue` only after the user chooses that scope. Exit `0`
means no deltas (or a quiet baseline), `10` means deltas, `1` is retryable, and
`2` needs repair. Never overlap ticks for this identity.
