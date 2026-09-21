# Coordinator fan-out

One coordinator pays for GitHub once and appends deltas; independent workers
read the same log through their own cursors.

```bash
# cron coordinator; capture its published log path after a changed tick
gh-delta --repo diegomarino/gh-delta-demo --monitor-id coordinator \
  --state-dir .gh-delta --entities pr --log --format json > coordinator.json
LOG_FILE=$(jq -r '.logFile' coordinator.json)

# bind each missing cursor to the producer log once, then advance independently
for worker in reviewer notifier triage; do
  cursor=".gh-delta/$worker.cursor.json"
  gh-delta cursor set "$cursor" 0 --log-file "$LOG_FILE"
  gh-delta read --cursor "$cursor" --number 42 --advance
done
```

This prevents three workers from repeating the same fetch. Keep cursor files
durable, distinct, and bound once to the same log. `run.sh` seeds, changes,
journals, and reads one local fixture through three cursors; it makes no network
request.
