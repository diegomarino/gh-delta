# Standard operating patterns

Use these as shapes, replacing identities, paths, conditions, and schedules
with the user's choices. Use `flags.md` when exact current grammar matters.

## Name and contain every scenario

Give agent-owned files a stable agent/role prefix and keep one scenario under
one exact root. For a shared producer use a role such as `coordinator`, not each
worker's name. Use stable lowercase slugs; do not put a PID or timestamp in the
live root.

```bash
AGENT=codex
PURPOSE=pr-42-ci
MONITOR_ID="$AGENT-$PURPOSE"
SCENARIO_ROOT=".gh-delta/$MONITOR_ID"
STATE_DIR="$SCENARIO_ROOT/state"
WATCH_DIR="$SCENARIO_ROOT/watch"
REPORT_DIR="$SCENARIO_ROOT/reports"
mkdir -p "$STATE_DIR" "$REPORT_DIR"
```

The `monitor-id` starts with the agent or role and ends with the purpose. Put
watch entries, reports, cursors, and other owned files below `SCENARIO_ROOT` so
inventory, filtering, recovery, and retirement do not depend on filename globs.

## Discover and confirm the current repository

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
printf 'GitHub repository: %s\n' "$REPO"
gh-delta doctor \
  --repo "$REPO" --monitor-id "$MONITOR_ID" --state-dir "$STATE_DIR" --format text
```

Confirm the repository when the request is ambiguous, especially when `origin`
is a fork and `upstream` differs. Ask whether the scope is PRs, issues, both, or
a specific search/item set.

Before launching recurring work, create `$SCENARIO_ROOT/OWNER.md` as a small
operator manifest. Record the real values, including the exact launcher and
stop command chosen for this machine:

```text
agent-or-role: codex
purpose: pr-42-ci
repository: owner/repo
monitor-id: codex-pr-42-ci
launcher: <cron entry, launchd label, systemd unit, or parent process>
stop command: <exact command that stops this scenario>
```

This file is documentation and inventory, not a shell script: never source it
or execute its contents automatically. Update it whenever ownership or the
launcher changes.

## Pattern 1: scheduler-owned repository monitor

Use one tick per scheduler invocation. The scheduler—not an LLM turn—owns the
cadence:

```bash
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --entities pr \
  --summaries \
  --format compact
```

Choose `issue` or `pr,issue` only after the user chooses that scope. Exit `0`
means no deltas (or a quiet baseline), `10` means deltas, `1` is retryable, and
`2` needs repair. Never overlap ticks for this identity.

## Pattern 2: wait for one PR condition

Persist the target once, then let `wait` perform targeted observations until a
semantic condition is true or the timeout expires:

```bash
PR_NUMBER=42

gh-delta watch add "pr:$PR_NUMBER" \
  --repo "$REPO" --watch-dir "$WATCH_DIR" --until merged --format text

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

On exit `10`, inspect `reason` and the observed summary before deciding what to
do. Exit `0` is timeout/signal, not success. This workflow observes only; it
does not authorize merge or review actions.

## Pattern 3: monitor a search or selected PR set

`gh-delta` does not persist an arbitrary GitHub search. Resolve the search,
then save at most ten selected PRs in the scenario's watch directory:

```bash
gh search prs --repo "$REPO" --state open --checks pending \
  --sort updated --order desc --limit 10 \
  --json number --jq '.[].number' |
while IFS= read -r number; do
  gh-delta watch add "pr:$number" \
    --repo "$REPO" --watch-dir "$WATCH_DIR" --until merged --format text
done

gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --watch-dir "$WATCH_DIR" \
  --entities pr \
  --format compact
```

A zero-to-ten PR-only watch list activates one targeted GraphQL request. Issue
entries, more than ten entries, or `--entities issue` retain broad fetching.
`--number` is a post-fetch output selector and does not reduce GitHub work.
Refresh search membership intentionally with `watch add`/`watch rm`; do not let
an unbounded list accumulate. Use `--until merged` for an integration workflow
or `--until closed` when an unmerged close is the terminal event. A merged PR
emits `merged`, not `closed`; remove the opposite terminal outcome during the
next membership refresh.

## Pattern 4: one producer, many consumers

The coordinator fetches once and publishes a durable log:

```bash
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --entities pr,issue \
  --log \
  --format json > "$REPORT_DIR/last-tick.json"

LOG=$(jq -r '.logFile' "$REPORT_DIR/last-tick.json")
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

## Pattern 5: find inactive work

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

## Retire or clean one scenario safely

Read the ownership manifest first. Confirm that its repository, monitor ID, and
purpose match the requested scenario. Run its recorded stop command explicitly
only after checking that the command still targets this exact scenario, then
verify that the scheduler or `wait` process has stopped:

```bash
printf 'Retiring scenario: %s\n' "$SCENARIO_ROOT"
sed -n '1,120p' "$SCENARIO_ROOT/OWNER.md"
gh-delta list --state-dir "$STATE_DIR" --format text
find "$SCENARIO_ROOT" -maxdepth 2 -type f -print
```

Prefer a recoverable retirement over deletion:

```bash
ARCHIVE=".gh-delta/retired/$(basename "$SCENARIO_ROOT")-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$ARCHIVE")"
mv "$SCENARIO_ROOT" "$ARCHIVE"
printf 'Archived at: %s\n' "$ARCHIVE"
```

The global monitor registry can retain a `stale` breadcrumb after state is
moved; that is diagnostic history, not a live monitor. Delete an exact archived
root only when the user explicitly requests permanent removal and after a
readback. Never clean with a broad agent-prefix glob.

## Output choice

- `compact`: bounded self-contained agent input.
- `ndjson`: streaming one-record-per-delta consumers.
- `json`: complete integration contract and structured detail.
- `text`: operator logs, not machine parsing.
- `--detail`: exact changed fields when the consumer must explain a delta.
- `--summaries`: current semantic PR state without a second GitHub fetch.
- `--enrich`: fetch review/comment/thread bodies only for matching emitted
  deltas, after snapshot publication.
