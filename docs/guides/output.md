# Output

[Documentation](../README.md) · [Usage by task](../usage.md)

## Agent compact and NDJSON

Use `--format compact` for one self-contained JSON envelope, or `--format
ndjson` for one JSON record per deterministic delta plus a final `end` record.
`delta.summary` is unconditional in both, and they preserve detector
snapshots and delta IDs. Use `--detail` only when the structured detail rows
are needed. Schemas are
available locally with `gh-delta schema --format compact`.

`--omit-end` is detector-only, default false, and valid only with `--format
ndjson`. Stdout is then the ordinary delta lines (or an empty string when there
are none); stderr carries prefixed compact JSON diagnostics instead of an `end`
record. Exit codes stay 0/10/1/2. Project config `"omit-end": true` and
`GH_DELTA_OMIT_END` follow the usual flag > env > project > user > default
precedence. `read` and `wait` do not accept the flag.

Text output consists of an ISO timestamp heartbeat line followed by one block per
delta:

```text
2026-07-01T12:05:00.000Z | 2 delta(s)

PR #42 "Add billing webhook": ci-changed, review-changed
classes: ci-changed, review-changed
suggested action: CI/review changed. Read checks and review threads before merge.

ISSUE #17 "Backfill customer imports": relabeled
classes: relabeled
suggested action: scope/state changed. Reassess dispatch.
```

When no deltas are found:

```text
2026-07-01T12:00:00.000Z | 0 delta(s)

No GitHub deltas since the last snapshot.
```

JSON output carries the machine-readable report. Use `--summary-line` for a
human display sentence and `--detail` for structured class-level explanations —
for `ci-changed` and `review-changed`, the details name the exact checks and
reviews that changed (`added`/`removed`/`changed`), so an agent can act without
re-querying GitHub. The exact JSON shape is specified in
[Report Shape](../contract/report.md#report-shape).

To silence known bot-only comment activity without losing state advancement, use
`--ignore-authors github-actions[bot],dependabot[bot]`. This filter is fail-open:
if the latest five-comment window cannot prove every new comment belongs to an
ignored author, the comment delta remains.

`gh-delta --help-json` prints machine-readable help for agents and other tooling.
It is the right source for generated CLIs, prompts, and monitors that need the
current command surface.
