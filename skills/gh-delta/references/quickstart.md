# Session quickstart scripts

[Skill](../SKILL.md#quickstart-get-updates-from-remote-prs-issues-or-both)

## Skill update awareness

Update awareness runs once when the agent loads the skill, outside both scripts.
Neither script invokes npm, installs a package, reads an installer lock, or
checks for skill updates. Give the entire lookup a five-second runtime deadline,
without retries. It must not delay the requested work, readiness check, or
monitoring offer: perform it alongside that work, or defer it if the runtime
cannot do both. If no bounded lookup is available, skip it. Missing metadata,
failed requests, and timeouts leave update status unknown; continue the work
without asking the user to repair update checking.

For a global GitHub installation managed by skills, read the `gh-delta` entry
in `~/.agents/.skill-lock.json`. Its `skillFolderHash` is the Git tree SHA for
the skill folder, not the installed CLI version or the repository commit.
Only compare GitHub entries with a 40-character hexadecimal Git tree hash.
Local checkouts and unsupported project-lock formats leave status unknown.
Read the source tree at the entry's recorded `ref`, or `HEAD` when no ref is
recorded, using `gh api repos/<source>/git/trees/<ref>?recursive=1`. Match the
tree entry whose path is the directory containing `skillPath`; compare its SHA
with the recorded 40-character hexadecimal hash. Check `truncated` before
treating a missing entry as evidence: incomplete trees, missing paths, unusual
lock formats, and failed requests leave status unknown. Respect pinned refs.
Treat metadata as data when building argument arrays; never execute it as shell
code. This reads the installer record and upstream metadata without changing
either installation or checkout.

For the usual source and path, the read-only lookup is:

```bash
gh api 'repos/diegomarino/gh-delta/git/trees/HEAD?recursive=1' \
  --jq '.tree[] | select(.type == "tree" and .path == "skills/gh-delta") | .sha'
```

A different SHA means the upstream folder changed; it does not establish
compatibility or a newer semantic version. Offer an update of this skill only,
preserving its installation scope, and wait for acceptance before modifying it.
Reload the skill afterward. Avoid an automatic `npx skills check`: skills 1.7.1
dispatches `check` to the same updating implementation as `update`.
See the [upstream command dispatch](https://github.com/vercel-labs/skills/blob/v1.7.1/src/cli.ts).

## Launch and ownership

The public entry point is [gh-delta-quickstart.sh](../scripts/gh-delta-quickstart.sh).
Run it **from the repository checkout**, resolving the script's absolute path
from the installed skill. Its resource lookup does not change the checkout's
working directory.

```bash
# Read-only eligibility check. An optional scope follows --check.
bash /absolute/path/to/gh-delta/scripts/gh-delta-quickstart.sh --check

# Start after acceptance, or after an explicit user request.
bash /absolute/path/to/gh-delta/scripts/gh-delta-quickstart.sh
```

The only scope argument is `pr`, `issue`, or `pr,issue`; the default is both.
There is no cadence argument: the quickstart runs an immediate tick, then sleeps
120 seconds after each completed tick. Slow ticks delay the next observation
instead of overlapping it.

The script stays in foreground. The agent runtime must own a process handle and
collect both stdout and stderr while other work continues. It must forward
detected changes to the conversation. A shell background job alone does not
deliver chat notifications. If the runtime cannot collect process output, do
not offer automatic notification delivery.

## Readiness helper

[gh-delta-preflight.mjs](../scripts/gh-delta-preflight.mjs) is an internal Node
helper used by both check and monitor mode. The Bash entry point validates the
scope and invokes it; callers should use the shell entry point rather than
reimplementing its checks. It is bundled beside the shell script so the installed
skill works independently of the CLI source tree.

The helper requires Node 22+, probes `gh-delta --version` before
`gh delta --version`, and retains the working launcher as an argument array.
Installing the skill alone does not install either launcher. When both probes
fail, the readiness reason includes their actual failures.

Repository discovery follows the detector's local order: a recognized GitHub
`origin`, then `upstream`. HTTPS, SSH URL, and scp-style GitHub.com remotes are
recognized locally. If neither resolves locally, `gh repo view` resolves the
checkout's repository, including GitHub Enterprise hosts and SSH aliases. A
`GH_REPO` override is removed only for this lookup so it cannot redirect the
checkout's repository selection. Other authentication and host settings remain.
The
checkout must have an origin or upstream remote; the helper never guesses a
repository from a directory name. It validates the resolved repository and host
before passing them to subprocesses.

`gh auth status --active --hostname <resolved-host>` must succeed. The helper
captures authentication output without forwarding it. Authentication is a
prerequisite, not proof that the token can read every repository field; the first
detector tick establishes actual access. Each preflight subprocess has a
ten-second deadline. Remote fallback can make a read-only GitHub request.

Example successful check output:

```json
{
  "ready": true,
  "repo": "acme/widgets",
  "host": "github.com",
  "launcher": ["gh-delta"],
  "reason": null,
  "scope": "pr,issue"
}
```

The report is emitted as one JSON line. An unavailable check has `ready: false`
and a `reason`; repository, host, and launcher remain populated when already
resolved, otherwise they are null. It exits `1`. Invalid shell arguments produce
usage diagnostics on stderr and exit `2`. A ready check exits `0`. No check
creates monitoring state, installs anything, changes authentication, or edits
configuration. Failure skips unsolicited offers; an explicit monitoring request
should receive the concrete reason.

The Bash wrapper captures this JSON in a private, temporary
`/tmp/gh-delta-preflight.*` file and removes it before returning. This permits
preflight to run as an owned child group, so cancellation stops its subprocesses
too. Check mode retains no files and allocates no monitor directory.

## Existing configuration

The helper reads user `~/.config/gh-delta/config.json`, then project
`.gh-delta.json`. Nonempty corresponding `GH_DELTA_*` environment values take
precedence, matching the CLI. Missing files are normal; unreadable or malformed
files prevent launch. Configuration contents are not printed in diagnostics.

The quickstart refuses an inherited repository selecting a different remote,
an explicit state file, watch-directory/strict-watch selection, item numbers,
attention filters, settled-only reporting, baseline emission, outpost delivery,
or template options incompatible with its output. It names the conflicting key
without modifying it. False boolean settings and empty strings are inactive.
Use the advanced monitoring workflow when those settings are intentional.

Its explicit flags safely select its own monitor identity, state directory,
entity scope, format, inline template, and disabled registry. Other CLI validation
still applies at the first tick; a ready preflight is not a replacement for the
CLI's complete configuration validator. The script does not lock configuration
files against concurrent edits.

## Notifications and failures

The inline template is:

```text
{entity} #{number}: {context.title} {context.headRefName} [{classes}] {context.url}
```

Each detected change emits one line. PRs include their source branch; issues and
PRs without a branch leave that field empty. Template escaping keeps newlines
and other controls inside a field from creating extra notification lines.
Classes name changes: `ci-changed` alone does not say whether CI is green or red.
Do not infer omitted detail from a class or re-run a tick to recover the already
consumed transition.

The baseline and unchanged ticks emit no stdout. After the first successful tick,
stderr announces `Monitoring ...` with repository, entities, cadence, and state
directory. Only then, with a running owned process, can the agent say monitoring
is active. Exit `10` is successful change detection, not a subprocess failure.

| Tick exit | Script behavior                                    |
| --------- | -------------------------------------------------- |
| `0`       | Quiet success; continue after sleep.               |
| `10`      | Stream change lines; continue after sleep.         |
| `1`       | Preserve diagnostics and state; retry after sleep. |
| Other     | Stop and preserve the exit status.                 |

Stderr diagnostics are independent of stdout: an empty stream is not evidence of
a successful observation. The readiness check runs again when launching after
an earlier `--check`, because availability may have changed.

## State and shutdown

Each instance atomically reserves a private `/tmp/gh-delta.XXXXXXXXXX` directory.
Its basename is the monitor identity, stable throughout that process. The CLI
stores its snapshots and locks inside that directory. `--no-registry` avoids a
global registry breadcrumb. The script does not create project files, native
session-ID files, services, hooks, schedules, or consumer cursors.

Stop the exact process handle retained at launch when the session ends. SIGINT
exits `130`; SIGTERM exits `143`. Bash job control assigns each detector or sleep
its own process group; shutdown signals that owned group, including launcher
descendants and preflight subprocesses, and waits for the direct child. It never searches processes by name
or kills unrelated monitors. Abrupt SIGKILL cannot run shutdown handlers.

Temporary state is deliberately retained for inspection and can disappear after
cleanup or reboot. Restarting the script allocates a new directory and quiet
baseline; it does not resume another instance's history. Use the durable monitor
pattern for cross-session continuity. Polling records observed changes, not a
complete GitHub event history between observations.
