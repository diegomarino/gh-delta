# Coordinator fan-out

One coordinator pays for GitHub once and appends deltas; independent workers
read the same log through their own cursors.

```bash
GH_DELTA_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta"
STATE_DIR="$GH_DELTA_HOME/snapshots"
CURSOR_DIR="$GH_DELTA_HOME/cursors"
mkdir -p "$CURSOR_DIR"

# cron coordinator; capture its published log path after a changed tick
gh-delta --repo diegomarino/gh-delta-demo --monitor-id coordinator \
  --state-dir "$STATE_DIR" --entities pr --log --format json > coordinator.json
LOG_FILE=$(jq -r '.results[0].logFile' coordinator.json)

# bind each missing cursor to the producer log once, then advance independently
for worker in reviewer notifier triage; do
  cursor="$CURSOR_DIR/$worker.cursor.json"
  if [ ! -f "$cursor" ]; then
    gh-delta cursor set "$cursor" 0 --log-file "$LOG_FILE"
  fi
  gh-delta read --cursor "$cursor" --number 42 --advance
done
```

This prevents three workers from repeating the same fetch. Keep cursor files
durable, distinct, and bound once to the same log; never reset an existing
cursor unless an explicit replay is intended. `run.sh` seeds, changes,
journals, and reads one local fixture through three cursors; it makes no network
request.
