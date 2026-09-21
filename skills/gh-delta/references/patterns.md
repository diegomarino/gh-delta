# Standard operating patterns

Use these as shapes, replacing identities, paths, conditions, and schedules
with the user's choices. Use `flags.md` when exact current grammar matters.

## Name and contain every scenario

Keep one session-owned scenario under one exact root named
`<agent-type>-<last8(session-id)>-<purpose>`. On resume, that conversation reuses
the same scenario, while a new session creates a new scenario rather than
silently adopting another session's snapshot. Use lowercase slugs; do not put a
PID or timestamp in the live root.

Use the runtime's native session identifier:

- Claude Code exposes `$CLAUDE_CODE_SESSION_ID` to Bash and PowerShell tools.
- Codex hooks receive `session_id`; subagent hooks receive the parent session
  ID. Pass that value into the setup as `SESSION_ID`.
- For another agent, use its documented persistent conversation/session ID.

Do not infer an ID from a transcript filename or invent one. If a session ID is
not available, ask the user. For a deliberately shared cross-session producer,
use a stable role such as `coordinator` instead of pretending it belongs to one
session.

```bash
AGENT_TYPE=codex
# Set SESSION_ID from the runtime source described above.
: "${SESSION_ID:?set SESSION_ID from the native session id}"
SESSION_TAG=$(printf '%s' "$SESSION_ID" | tr -cd '[:alnum:]' | tail -c 8 | tr '[:upper:]' '[:lower:]')
[ "${#SESSION_TAG}" -eq 8 ] || { printf 'session id needs eight alphanumeric characters\n' >&2; exit 2; }
PURPOSE=pr-42-ci
MONITOR_ID="$AGENT_TYPE-$SESSION_TAG-$PURPOSE"
SCENARIO_ROOT=".gh-delta/$MONITOR_ID"
STATE_DIR="$SCENARIO_ROOT/state"
WATCH_DIR="$SCENARIO_ROOT/watch"
REPORT_DIR="$SCENARIO_ROOT/reports"
mkdir -p "$STATE_DIR" "$REPORT_DIR"
```

Take the last eight alphanumeric characters after normalizing the native ID;
the tag is a compact locator, not a secret or authentication token. The
`monitor-id` starts with the agent type, then the session tag, and ends with the
purpose. Put watch entries, reports, cursors, and other owned files below
`SCENARIO_ROOT` so inventory, filtering, recovery, and retirement do not depend
on filename globs.

`gh-delta` is one-shot and does not create a daemon. The launcher that invokes
it owns the process lifecycle: a foreground shell owns its loop or `wait`, and
cron, launchd, systemd, or another scheduler owns recurring ticks. When the
launcher supports names, give its job the same `$MONITOR_ID`; keep launcher
configuration and stop controls in that launcher rather than duplicating them
inside the scenario directory.

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

Stop work at its actual owner before moving state: interrupt and wait for a
foreground shell loop or `gh-delta wait`; disable the exact named scheduler job
for cron, launchd, or systemd; or use the stop handle returned by another
launcher. Do not discover a process by a broad `grep` and kill it by prefix. If
the launcher cannot be identified confidently, leave the scenario in place and
ask the user.

Then confirm that the exact root matches the requested agent type, eight
character session tag, and purpose, and inspect the owned state:

```bash
printf 'Retiring scenario: %s\n' "$SCENARIO_ROOT"
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
