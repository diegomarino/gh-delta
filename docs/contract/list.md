# gh-delta list

[Documentation](../README.md) · [Contract reference](../contract.md)

```
gh-delta list [--state-dir <dir>] [--since <duration>] [--format json|text]
```

Read-only inventory of the monitors that have run on this machine. `list` never
contacts GitHub and never creates, updates, or deletes snapshots or registry
entries, so it is safe to run at any time, including while monitors tick.

- **Scope.** Without `--state-dir` the inventory is **global**: the
  [run registry](registry.md#run-registry) — which every successful detector run feeds
  unless opted out — merged with a scan of the per-user temp default location.
  Monitors using any `--state-dir` or an explicit `--state-file` appear via
  their registry entries. With `--state-dir`, the inventory narrows to a plain
  scan of that directory and the registry is not consulted.
- A scan identifies a snapshot two ways: the derived filename (encodes repo,
  monitor id, and entities), or — for arbitrary filenames — the identity the
  detector stamps inside the snapshot (`meta.repo`, `meta.monitorId`,
  `meta.entities`; see [Snapshot Semantics](snapshots.md#snapshot-semantics)). Economical
  Targeted watch entries additionally expose `scope: "watch-pr"`, `"watch-issue"`,
  or `"watch-pr-issue"`. Files
  identified neither way are counted in `skippedFiles`.
- A missing state directory or registry is an empty inventory (exit `0`), not
  an error.
- `--since` is optional. Grammar: a positive integer followed by one unit —
  `s`, `m`, `h`, or `d` (e.g. `90s`, `15m`, `24h`, `7d`). Only monitors whose
  `lastRun` falls inside the window are listed. Without it, every known monitor
  is listed.
- `--format` defaults to `json`; `text` is the operator/log mode.
- `--help`, `--help-json`, and `--version` follow the same indestructible-help
  precedence as the detector; `gh-delta list --help-json` documents this
  subcommand.

Success report (exit `0`; the shape is also available as `reportFields` /
`monitorFields` in `gh-delta list --help-json` and as `LIST_REPORT_FIELDS` /
`LIST_MONITOR_FIELDS` in `gh-delta/contract`):

```json
{
  "schemaVersion": 2,
  "command": "list",
  "stateDir": "/tmp/gh-delta-user",
  "registryDir": "/home/user/.local/state/gh-delta/registry",
  "since": "24h",
  "at": "2026-07-08T12:00:00.000Z",
  "monitors": [
    {
      "repo": "owner/repo",
      "monitorId": "prs-5m",
      "entities": ["pr"],
      "schemaVersion": 2,
      "stateFile": "/srv/state/repo-owner%2Frepo__monitor-prs-5m__pr.json",
      "lastRun": "2026-07-08T11:00:00.000Z",
      "prCount": 12,
      "issueCount": 0
    }
  ],
  "skippedFiles": 0,
  "summary": "1 monitor(s)"
}
```

- `command` (string): always `"list"`; discriminates this report from a
  detector report.
- `registryDir` (string|null): the run-registry directory consulted, or `null`
  when `--state-dir` narrowed the inventory to a scan.
- `since` (string|null): the echoed `--since` value, or `null` when no window
  was given.
- `monitors` (array): sorted by `lastRun`, newest first. `lastRun` is the
  snapshot's `meta.horizon` when readable; the registry `lastRun` or file mtime
  otherwise (corrupt or unreadable snapshots). A corrupt snapshot keeps its
  entry with an `error` string and `null` counts instead of failing the
  listing. A registered monitor whose snapshot file no longer exists keeps its
  entry with `stale: true` — a retired monitor or cleaned state, reported
  rather than hidden. `schemaVersion` (number|null) is the snapshot's
  `meta.schemaVersion` when the snapshot is readable, `null` otherwise — a
  monitor stuck on a pre-schema-v2 snapshot needs `gh-delta reset`. Additive
  diagnostics are `lastAttemptAt`, `lastOkAt`, `lastError` (`null` or
  `{kind,message,at}`), `observationAgeMs`, and `snapshotStatus` (`present`,
  `corrupt`, `expected-missing`, or `not-yet-created`). `--since` filters by
  the same successful-observation timestamp; a failed first attempt has no
  observation and does not pass it.
- `skippedFiles` (number): directory or registry entries that could not be
  identified as monitor snapshots or registry entries. They are counted, never
  guessed at.
- `summary` (string): human-readable only; do not parse it.

Exit codes: `0` inventory produced (possibly empty), `1` transient error (state
directory unreadable), `2` permanent error (invalid arguments). `list` never
exits `10`. Error reports use the standard
[error report shape](errors.md#error-report-shape).
