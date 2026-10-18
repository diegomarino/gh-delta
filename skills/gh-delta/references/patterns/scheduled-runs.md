# Pattern 6: one-shot runs from a scheduler

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Use for cron, CI, routines, and scheduled agents: every invocation is a fresh
process that runs one tick and exits. The session quickstart loop is wrong here;
it blocks and keeps temporary state.

```bash
cd /path/to/acme/widgets   # a checkout whose origin/upstream is the repo
bash "$SKILL_DIR/scripts/gh-delta-quickstart.sh" --once \
  --state-dir /persistent/path/state --monitor-id acme-widgets-prs pr
```

`--once` takes no `--repo`: the preflight resolves the repository from the
current directory's GitHub remote, so run it from a checkout of that repository.
It runs the quickstart preflight, then exactly one tick, printing the quickstart
template lines; a separate `--check` beforehand is redundant. Without the
script, the raw tick is
`gh-delta --repo "$REPO" --monitor-id ID --state-dir DIR --no-registry --entities pr --format compact`.
`--no-registry` keeps each run self-contained: it writes only to its state dir.
For a long-lived monitor that `list`/`status` should discover, use
[Pattern 1](repository-monitor.md), which registers it.

- **Persistent state dir.** Pass a directory that survives between runs. Default
  or temporary state makes every run a first run: a silent baseline that reports
  nothing.
- **Constant monitor id.** The scheduler or its prompt fixes the id. Never derive
  it from a session ID, PID, or timestamp.
- **Exit codes.** `0` no change (the first run is a silent baseline, also `0`),
  `10` deltas on stdout, `1` retryable fetch failure (state intact), `2` fix
  configuration. Branch on the code before reading output.
- **Exit `0` prints nothing on stdout**, for the baseline and for no change.
  Warnings such as `team-reviewers-unavailable` still go to stderr; read it.
- **Exit `1` has two causes.** A failed preflight also exits `1` and prints one
  JSON line on stdout with `"ready":false` and a `reason`; without that line,
  the tick itself failed transiently. Either way, report the reason, change
  nothing, and let the next scheduled run try again; escalate to the user only
  when the same `ready:false` reason repeats across runs. Most reasons are
  setup problems (Node or the CLI missing, no GitHub remote, invalid token:
  `GitHub CLI is not authenticated`). A reason starting with
  `GitHub token cannot read` usually means the token lacks access to the
  repository, but the readiness probe also reports it when GitHub is
  unreachable or times out, so a single occurrence is not proof of a token
  problem.
- **One run at a time** per state dir; make the schedule longer than a run.
- **State loss is a silent re-baseline.** After the state dir is wiped, the next
  run records current state and reports nothing. Changes made between the loss
  and that run are never reported. Check that the dir exists before trusting a
  quiet run, and treat a missing dir as a gap to tell the user about.
- **Resolve scripts at runtime.** Plugin install paths contain a commit SHA, so
  never hardcode them. Take `SKILL_DIR` from the directory holding the loaded
  SKILL.md, or `$(npm root -g)/gh-delta/skills/gh-delta`.

## Grok Bot and other cloud agents

Shared Linux box, `/workspace`, routines with a 5-minute minimum cron.

- **Routines never install.** When `--once` reports `"ready":false` (Node or the
  CLI missing, among other reasons), stop and report its `reason`; change
  nothing on the machine.
- **Setup is the user's step.** The user performs, or explicitly authorizes, a
  one-time install: Node 22+ in user space if absent (official tarball from
  nodejs.org, verified against `SHASUMS256.txt`, extracted under
  `/workspace/.tools/node22`, its `bin` first on `PATH`), then
  `npm install -g gh-delta@<version>` with a pinned version and
  `NPM_CONFIG_PREFIX=/workspace/.tools/node22` (the box presets its own), so
  the CLI lands in that same `bin`. "Update Bot's Computer" can remove
  user-installed packages; whether `/workspace/.tools` survives it is unverified.
  If `--once` then reports the CLI missing, repeating this setup is likewise
  the user's step.
- **Isolated auth.** Run with an empty `GH_CONFIG_DIR` and a per-bot `GH_TOKEN`
  secret (read-only) rather than the box's shared `gh` session:

  ```bash
  export GH_CONFIG_DIR="$(mktemp -d)"
  trap 'rm -rf "$GH_CONFIG_DIR"' EXIT
  # GH_TOKEN comes from the bot secret; never write it to disk.
  ```

  A classic token without `read:org` works; team reviewers then show as `?`
  with a `team-reviewers-unavailable` warning. A fine-grained token suits
  personal repositories. On organization repositories with team review requests
  it may fail; granting organization Members: read is the likely fix
  (unverified).

- **Trigger choice.** GitHub-event routines suit one PR. Use cron for issues or
  several repositories: at least 5 minutes, ideally 30-60.
- **One state dir per bot** (`/workspace/.gh-delta/<bot>/state`); two bots on one
  snapshot consume each other's deltas.
- **Cost.** Each routine run is a full agent turn; a slower cadence is cheaper.
- **No session id.** Put a constant monitor id in the routine prompt.
