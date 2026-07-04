# Architecture

`gh-delta` is intentionally narrow: it turns `(old snapshot, current GitHub
state)` into a categorized delta report. It does not schedule itself, open
browser sessions, merge pull requests, or send messages to workers.

## Product boundaries (explicit)

`gh-delta` separates detection, delivery, and action:

- Detection is authoritative for local comparison and exit-code signals.
- Delivery is optional and best-effort (`--outpost-url`), warning-only on failure.
- Action planning and execution are always outside this package.

Given identical input snapshot and fetch results, detection output is deterministic.

## Boundaries

```text
watch loop / timer
  -> gh-delta.mjs
      -> lib/cli.mjs          internal CLI runner used by bin/tests only
      -> lib/args.mjs         parse shared CLI option policy
      -> lib/gh.mjs           fetch current GitHub state with gh
      -> lib/snapshot.mjs     read previous snapshot
      -> lib/detect.mjs       compare old and current fingerprints
      -> lib/snapshot.mjs     atomically write new snapshot
      -> lib/outpost.mjs      optional HTTP POST per delta
      -> lib/text-output.mjs  optional operator text formatting
  -> caller decides what to do with deltas
```

The public CLI is one one-shot command. `--format json` prints the structured
report for programs. `--format text` prints an operator heartbeat and suggested
actions for scheduled logs. Neither format creates schedules, timers,
automations, or wake-ups.

## Failure safety guarantees

- Argument, authentication, and parse/network errors do not update snapshots.
- Snapshot writes are atomic and only occur after a successful fetch+diff cycle.
- If GitHub list/results are truncated (exactly 500) or review-thread paging is
  incomplete, the command exits `1` and does not write the snapshot.
- Outpost transport errors are collected as warnings and never alter the detector
  exit code.

## Runtime Flow

The process entrypoint is deliberately thin:

```text
process argv
  -> choose requested output format
  -> when format is text, add detector detail unless already requested
  -> run the detector, with optional outpost delivery
  -> render stdout/stderr
  -> exit with the detector code
```

Argument and configuration flow:

```text
start
  -> strip and validate optional --outpost-url
     -> invalid URL or non-HTTP(S) URL
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
  -> parse detector arguments
     -> unknown option or parse error
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
     -> --help or --help-json
        -> exit 0
        -> no GitHub fetch
        -> no snapshot read or write
     -> --version
        -> read package metadata
        -> exit 0
        -> no GitHub fetch
        -> no snapshot read or write
     -> missing --repo or --monitor-id
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
     -> both --state-file and --state-dir
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
     -> neither --state-file nor --state-dir
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
     -> invalid --entities or --format
        -> exit 1
        -> no GitHub fetch
        -> no snapshot read or write
```

Snapshot path selection:

```text
validated args
  -> --state-file present
     -> use that exact path
  -> --state-dir present
     -> derive <state-dir>/repo-<encoded repo>__monitor-<encoded monitor-id>__<entities>.json
```

Detection flow:

```text
resolved snapshot path
  -> read snapshot file
     -> file does not exist
        -> old snapshot is null
     -> snapshot JSON parses but has invalid shape
        -> exit 1
        -> GitHub is not fetched
     -> invalid JSON
        -> exit 1
        -> GitHub is not fetched
  -> fetch requested GitHub entities
     -> GitHub CLI, network, parse, or hard-limit error
        -> exit 1
        -> snapshot is not written
     -> open PR review thread GraphQL count is incomplete
        -> exit 1
        -> snapshot is not written
        -> current GitHub state becomes the baseline
        -> write new snapshot
        -> exit 0
     -> file is valid JSON
        -> compare old snapshot with current GitHub state
        -> preserve unrequested entity families
        -> write refreshed snapshot
        -> exit 0 when there are no deltas
        -> exit 10 when there are deltas
     -> file is invalid JSON
        -> exit 1
        -> target snapshot is not replaced
```

Outpost flow:

```text
detector result
  -> exit 0 or exit 1
     -> do not POST
  -> exit 10 with --outpost-url
     -> snapshot has already advanced
     -> POST one payload per delta
     -> collect delivery failures as warnings
     -> keep detector exit code 10
```

The core correctness logic is pure:

- `args.mjs` parses reusable CLI argument policy without touching process I/O.
- `fingerprint.mjs` converts GitHub objects into stable fingerprints.
- `detect.mjs` compares fingerprints and emits delta classes.

The impure edges are isolated:

- `gh.mjs` shells out to `gh` for list fetches and GraphQL enrichment.
- `snapshot.mjs` performs filesystem I/O and derives monitor-scoped snapshot
  paths.
- `outpost.mjs` validates optional outpost URLs, builds schema v1 payloads, and
  sends short-timeout HTTP POSTs.
- `text-output.mjs` formats heartbeat text and outpost warnings.
- `version.mjs` reads package metadata for version output and help JSON.
- `help.mjs` keeps human `--help` and machine-readable `--help-json` output in
  one versioned source of truth.
- `entrypoint.mjs` detects direct CLI invocation through real paths so npm/npx
  `.bin` symlinks start the package bin correctly.
- `lib/cli.mjs` wires CLI flags, GitHub fetches, snapshot I/O, output formats,
  outposts, and exit codes.
- `gh-delta.mjs` is the executable bin entrypoint only. It delegates to
  `lib/cli.mjs` and does not define a public import surface.

## Package Surface

The npm package exposes one CLI and a small ESM import surface:

- `gh-delta`: one-shot detector CLI.
- `gh-delta/detect`: pure delta classification.
- `gh-delta/fingerprint`: GitHub object fingerprint helpers.
- `gh-delta/outpost`: outpost payload and delivery helpers.
- `gh-delta/snapshot`: snapshot path/read/write helpers.
- `gh-delta/args`: shared argument parsing helpers.
- `gh-delta/version`: package metadata and version text helpers.

The package root is intentionally not exported. `package.json#main` still points
at `gh-delta.mjs` for metadata compatibility, but supported programmatic imports
must use explicit subpaths. `lib/cli.mjs` remains an internal source module for
the package bin and local tests, not a published package export.

Everything under `lib/` should stay dependency-free unless the added dependency
materially improves correctness. The package currently has no runtime
dependencies.

## Monitor Identity

`--monitor-id` is the stable identity of a recurring monitor. It is not a branch,
selector, interval, or execution id. Every scheduled fire for the same monitor
should reuse the same `--monitor-id`.

With `--state-dir`, snapshot paths are derived from:

```text
repo + monitor-id + entities
```

Example:

```text
./state/repo-org%2Fapp__monitor-prs-5m__pr.json
```

`--state-file` bypasses path derivation for operators that need a fully explicit
path, but `--monitor-id` is still required because reports and outpost event IDs
use it.

## GitHub Fetch Contract

PRs are fetched with `--state all --limit 500`. Both flags matter:

- `--state all` keeps merged and closed PRs observable. Without it, a merged PR
  can disappear from the result set and become indistinguishable from scope loss.
- `--limit 500` avoids the default low limit hiding older PRs or issues. It is
  not full pagination. If GitHub returns exactly 500 PRs or issues, `gh-delta`
  exits `1` without writing the snapshot because the monitor scope may be
  truncated.

Open PRs are then enriched with `gh api graphql --paginate --slurp` to count PR
review threads:

- `reviewThreads.totalCount` becomes the tracked review-thread total.
- `reviewThreads.nodes[].isResolved` is counted into unresolved review threads.
- top-level PR pagination is handled by `gh api graphql --paginate`.
- nested `reviewThreads(first: 100)` pagination is not followed yet. If any open
  PR reports more review-thread pages, `gh-delta` exits `1` without writing the
  snapshot because unresolved-thread counts would be incomplete.

The PR fingerprint tracks:

- state
- updated timestamp
- draft status
- canonicalized CI rollup hash
- review decision
- latest review state hash
- mergeability
- comment count
- comment-array overflow flag
- review thread count
- unresolved review thread count
- head SHA

The issue fingerprint tracks:

- state
- updated timestamp
- sorted labels
- comment count
- comment-array overflow flag

GitHub CLI list commands expose comment arrays, not GraphQL `totalCount` fields.
When those arrays reach the observed cap, `gh-delta` treats an `updatedAt` bump
as `new-comments` instead of degrading it to plain `updated`. This is
intentionally conservative until a future GraphQL enrichment can use exact totals
for issue comments, PR conversation comments, and review comments.

## Snapshot Contract

Snapshots are plain JSON maps keyed by issue or PR number:

```json
{
  "pr": {
    "42": {
      "state": "OPEN",
      "updatedAt": "2026-07-01T10:00:00Z"
    }
  },
  "issue": {}
}
```

Missing snapshots are treated as a first run. Corrupt snapshot JSON is an error:
the command exits `1` and leaves the snapshot untouched. This prevents a corrupt
file from silently erasing monitor memory.

Writes are atomic for a single writer: the snapshot is written to a unique
temporary file beside the target, then renamed into place. Do not run
overlapping ticks against the same state file; use scheduler-level locking if
overlap is possible.

Successful detections are at-most-once from the detector's perspective. The
snapshot advances before an agent acts on deltas and before optional outpost
delivery is attempted. Operators that need at-least-once action delivery should
persist the detector output or add an external pending/ack queue.

## Outpost Contract

`--outpost-url` is an optional edge on `gh-delta.mjs`. It is not part of
`lib/detect.mjs`; the detector still only returns facts.

The URL must be `http:` or `https:` and is validated before GitHub fetches begin.
When the detector exits `10`, one schema v1 payload is POSTed per delta. No POST
is attempted for exit `0` or `1`.

Outpost sends are deliberately minimal:

- short timeout;
- no retries;
- no durable outbox;
- no batching;
- no HMAC or auth layer yet;
- no logging of endpoint URLs, query strings, headers, or token material.

Failures are warnings, not detector failures. A timeout, DNS failure, HTTP `4xx`,
or HTTP `5xx` does not alter the detector exit code and does not cause another
snapshot write.

See [Outpost payload schema v1](contract.md#outpost-payload-schema-v1) for the full schema v1 envelope. `eventId` is deterministic from repo, monitor id, entity, number, and class list; `deliveryId` adds the detector timestamp for one delivery attempt. The external endpoint owns filtering, deduplication, and actions.

## Error Contract

If fetching or parsing fails, `gh-delta` exits `1` and does not write the
snapshot. This keeps transient network or rate-limit failures from erasing the
previous known-good baseline.

## Future Entity And Selector Research

The public contract currently supports only `pr`, `issue`, and `pr,issue`.
Research notes under `docs/entities-research/` inventory future entities and
selector applicability. A selector such as `branch` must be validated per entity
before it becomes public; for example, branch selectors can apply to commits or
workflow runs, but not to issues.

## Delta Classification

Each changed object can emit one or more classes: see [Delta Classes](contract.md#delta-classes) for the full list.

`updated` is the recall-over-precision fallback. It fires when the fingerprint
changed but no more specific class matched.

`missing` fires when a previously known object disappears from a fetched
collection. The old fingerprint is retained so the watcher does not silently
lose memory if GitHub output was truncated or scoped unexpectedly.

`still-missing` fires on later ticks when that same retained object remains
absent. This lets agents distinguish first sighting from unresolved operational
state.
