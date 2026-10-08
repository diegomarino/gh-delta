# Name and contain every scenario

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

For the [session quickstart](../../SKILL.md#quickstart-get-updates-from-remote-prs-issues-or-both),
the script allocates an exclusive `/tmp/gh-delta.*` root and derives its identity
from that directory. No native session ID is needed. Reuse that root throughout
the running process; do not adopt another process's state.

For advanced monitors, keep one session-owned scenario under one exact root named
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
