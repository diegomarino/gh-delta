# Pattern 4: one producer, many consumers

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

The coordinator fetches once and publishes a durable log:

```bash
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --entities pr,issue \
  --log \
  --format json > "$REPORT_DIR/last-tick.json"

LOG=$(jq -er '.results[0] | select(.error == null) | .logFile // empty' "$REPORT_DIR/last-tick.json") || exit 2
gh-delta cursor set "$SCENARIO_ROOT/reviewer.cursor.json" 0 --log-file "$LOG"
```

Each consumer has one cursor. Read first, persist the work, then acknowledge the
complete scanned tail:

```bash
gh-delta read \
  --cursor "$SCENARIO_ROOT/reviewer.cursor.json" \
  --format json > "$REPORT_DIR/reviewer-batch.json"

# Durably handle or enqueue every returned delta here; deduplicate by delta.id.
NEXT=$(jq -r '.cursor.to' "$REPORT_DIR/reviewer-batch.json")
gh-delta cursor set "$SCENARIO_ROOT/reviewer.cursor.json" "$NEXT"
```

Use `logFile` from the producer report; never synthesize its encoded filename.
Create one cursor per consumer. Use `read --advance` only when advancing before
downstream handling is an accepted delivery trade-off.
