# CLI

[Documentation](../README.md) · [Contract reference](../contract.md)

```
gh-delta [--repo <owner/name>] [--monitor-id <id>]
         [--state-file <path> | --state-dir <dir>]
         [--entities pr,issue] [--format json|text|compact|ndjson|template]
         [--template <text> | --template-file <path>] [--template-sha256 <hex>]
         [--omit-end] [--summary-line] [--detail] [--summaries] [--full]
         [--stale-after <duration>]
         [--only-classes <classes>] [--ignore-classes <classes>] [--ignore-authors <logins>] [--settled]
         [--baseline-emit-state]
         [--log]
         [--enrich review,comments,threads,body,thread-replies]
         [--outpost-url <url>]
         [--outpost-secret <ENV_VARIABLE_NAME>]
         [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>]
         [--gh-timeout-ms <ms>] [--rate-limit-floor <n>]
         [--no-registry] [--lock-stale-ms <duration>]
```

- `--repo` is **optional**. An explicit value always wins. When omitted,
  `owner/name` is derived from the current directory's git remotes, tried in
  this precedence order:
  1. `origin`, parsed from `git remote get-url origin` — github.com only.
  2. `upstream`, parsed from `git remote get-url upstream` — github.com only.
  3. `gh repo view --json nameWithOwner` — a fallback that covers GitHub
     Enterprise hosts and SSH-config host aliases the URL parser cannot
     identify by hostname alone.
  4. None of the above resolve a repo: the run **declines** with a `config`
     error (exit `2`).

  When `origin` and `upstream` both resolve but to **different** repos,
  `origin` is used and a `warnings` entry (`label: "repo"`) names the repo that
  was set aside; pass `--repo` explicitly to choose the other one. The
  resolved source is echoed on success reports as `results[].repoSource`
  (`"flag"` | `"git-remote"` | `"gh"`) — see [Report Shape](report.md#report-shape).

  **Exit-code note:** a `gh` **timeout while deriving** `--repo` (step 3 above)
  is a `github` error (exit `1`, transient — retry next tick), distinct from
  "no repo derivable" (steps 1–4 all declined), which is a `config` error
  (exit `2`, permanent). This mirrors the general transient/permanent split in
  [Exit Codes](exit-codes.md#exit-codes).

- `--monitor-id` is optional. Default: `host-` + the first 12 hex characters of
  the sha1 of hostname plus the Git worktree toplevel (or resolved cwd outside
  Git), so subdirectories share a monitor while separate worktrees do not. The
  hostname and path never appear in reports. `GH_DELTA_MONITOR_ID` supplies an
  environment default, while an explicit `--monitor-id` wins.
- `--repo` must be `owner/name`. **Canonicalized to lowercase** — snapshot paths
  and report echoes always use the lowercased form. This applies whether
  `--repo` was passed explicitly or derived. It may be comma-separated or
  repeated. Two or more explicit repositories run complete ticks serially;
  `--state-file` is rejected for that mode because one file cannot safely
  represent several repositories. Use `--state-dir` or the derived repo-scoped
  paths instead.
- `--monitor-id` must start with a letter or number and contain only letters,
  numbers, dot, underscore, or dash.
- `--state-file` and `--state-dir` are mutually exclusive and **optional**. When
  neither is given, the snapshot lives at
  `<system temp dir>/gh-delta-<user>/repo-<repo>__monitor-<id>__<entities>.json`;
  the directory is per-user (`0700`) and **ephemeral** — reboots and tmp cleanup
  silently re-seed the baseline; pass `--state-dir` explicitly for durable
  monitors. `--state-file` is an explicit snapshot path; `--state-dir` derives a
  path scoped by repo, monitor id, and selected entities (see
  [Snapshot Semantics](snapshots.md#snapshot-semantics)). Both together exit `2` (config).
  An eligible economical `--watch-dir` tick deliberately selects an independent
  derived `__watch-pr.json` path (or `<state-file>.watch.json`) instead. Strict
  issue-only and mixed-with-issues ticks use `__watch-issue.json` and
  `__watch-pr-issue.json` (explicit siblings `.watch-issue.json` and
  `.watch-pr-issue.json`). Those files are new baselines; they do not replace
  `watch-pr` or a poll snapshot.
- `--entities` defaults to `pr,issue`. Accepted: `pr`, `issue`, `pr,issue`.
- `--format` defaults to `json`. `text` is an operator/log mode; `compact` and
  `ndjson` are agent formats. Compact deltas are ordered by requested
  repository, PR before issue, then number; NDJSON finishes with exactly one
  `end` record and newline. Detector `--omit-end` (default false) is valid only
  with effective format `ndjson`: stdout is the same delta lines without `end`
  (empty string when there are zero deltas), and diagnostics that would have
  lived on `end` are stderr text `gh-delta: error <compact JSON>` then
  `gh-delta: warning <compact JSON>`, one LF per line, not NDJSON record types.
  A quiet successful tick is zero stdout bytes and the original exit code.
  Consumers must observe process completion and status because completeness,
  counts, and `exitCode` are absent from the stream. `"omit-end"` is a Boolean
  config key; `GH_DELTA_OMIT_END` accepts `true|false|1|0`. `read`, `wait`, and
  other subcommands reject the flag. Invalid format pairings use that format's
  ordinary error renderer (invalid format falls back to JSON) and do not get a
  quiet-stdout guarantee.

  `template` emits one LF-terminated escaped text
  line per emitted delta (or empty stdout when there are none). It is not
  NDJSON and does not emit `end`. `--format template` requires exactly one of
  `--template <text>` or `--template-file <path>` on detector ticks and
  `read`. `--template-sha256` is CLI-only, requires a file, and is compared
  case-insensitively to the SHA-256 of the **raw file bytes** before one
  trailing LF/CRLF is stripped. Relative `--template-file` paths resolve
  against the process working directory. `template` and `template-file` are
  one source-selection group (CLI > env `GH_DELTA_TEMPLATE` /
  `GH_DELTA_TEMPLATE_FILE` > project config > user config); the highest layer
  that supplies either source wins entirely. A source override does not change
  `format`. `read` does not inherit detector template config. `wait` and other
  subcommands reject template format and template options. Substituted values
  escape `\`, LF, CR, TAB, and other C0/C1/DEL/U+2028/U+2029; escaping does
  not make GitHub-authored title or body text safe to execute. Placeholder
  `{watch.labels.task.id}` looks up the single own-property key `task.id`.
  The allowlist, grammar, file bounds, and diagnostics are specified in
  [Per-delta templates](templates.md#per-delta-templates).
