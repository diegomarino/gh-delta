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
      -> lib/contract.mjs     runtime contract constants
      -> lib/gh.mjs           incremental GraphQL fetch of GitHub state
      -> lib/snapshot.mjs     read previous snapshot; derive horizon cutoff
      -> lib/detect.mjs       compare old and current fingerprints
      -> lib/snapshot.mjs     atomically write new snapshot (with meta.horizon)
      -> lib/outpost.mjs      optional HTTP POST per delta
      -> lib/text-output.mjs  optional operator text formatting
  -> caller decides what to do with deltas
```

The public CLI is one one-shot command. `--format json` prints the structured
report for programs. `--format text` prints an operator heartbeat and suggested
actions for scheduled logs. Neither format creates schedules, timers,
automations, or wake-ups.

## Failure safety guarantees

- Config and snapshot errors exit `2` (permanent); GitHub and I/O errors exit
  `1` (transient). Snapshots are never updated on any error path.
- Snapshot writes are atomic and only occur after a successful fetch+diff cycle.
- Open-items fetch fails closed beyond 1 000 items (10 pages × 100) per family;
  updated-items fetch fails closed beyond 3 000 items (30 pages × 100) per tick.
  Per-item nested-pagination overflow is also a hard error.
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
  -> pre-scan for --help, --help-json, --version (wins over all other flags)
     -> --help or --help-json
        -> exit 0
        -> no GitHub fetch
        -> no snapshot read or write
     -> --version
        -> read package metadata
        -> exit 0
        -> no GitHub fetch
        -> no snapshot read or write
  -> strict argument parse
     -> unknown option or parse error
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate --repo
     -> missing or invalid owner/name form
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate --monitor-id
     -> missing or invalid characters
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate state flags
     -> both --state-file and --state-dir
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
     -> neither --state-file nor --state-dir
        -> derive per-user temp default (mkdir 0700 + ownership check)
        -> ownership mismatch (dir owned by a different uid)
           -> exit 1 (io: transient)
           -> no GitHub fetch
           -> no snapshot read or write
        -> mkdir or stat fails
           -> exit 1 (io: transient)
           -> no GitHub fetch
           -> no snapshot read or write
        -> ownership check is a no-op on Windows (process.getuid absent)
  -> validate --entities
     -> invalid value
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate --format
     -> invalid value
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate --outpost-url (if present)
     -> invalid URL or non-HTTP(S) URL
        -> exit 2 (config: permanent)
        -> no GitHub fetch
        -> no snapshot read or write
  -> validate numeric flags (--outpost-timeout-ms, --outpost-max-posts, --gh-timeout-ms)
     -> non-positive-integer value
        -> exit 2 (config: permanent)
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
  -> neither present
     -> derive <os.tmpdir()>/gh-delta-<encoded user>/repo-<encoded repo>__monitor-<encoded monitor-id>__<entities>.json
     -> directory created with mode 0700 (per-user isolation on shared /tmp)
     -> ownership guard on POSIX: uid mismatch → exit 1 (io)
```

Detection flow:

```text
resolved snapshot path
  -> read snapshot file
     -> file does not exist
        -> old snapshot is null (will seed baseline)
     -> file exists, parses as valid JSON with correct shape
        -> proceed to fetch
     -> file exists, invalid JSON
        -> exit 2 (snapshot: permanent)
        -> GitHub is not fetched
     -> file exists, valid JSON but invalid shape
        -> exit 2 (snapshot: permanent)
        -> GitHub is not fetched
  -> fetch requested GitHub entities
     -> error (GitHub CLI, network, timeout, or page cap exceeded)
        -> exit 1 (github: transient)
        -> snapshot is not written
     -> per-item nested-page overflow (statusCheckRollup, latestReviews,
        reviewThreads, labels)
        -> exit 1 (github: transient)
        -> snapshot is not written
     -> success
        -> compare old snapshot with current fetch
        -> preserve unrequested entity families
        -> write snapshot (with meta.horizon = run timestamp)
        -> exit 0 when baseline or no deltas
        -> exit 10 when deltas
```

Outpost flow:

```text
detector result
  -> exit 0, 1, or 2
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

- `gh.mjs` shells out to `gh api graphql` for incremental GraphQL fetches.
- `snapshot.mjs` performs filesystem I/O, derives monitor-scoped snapshot paths,
  and computes the incremental-fetch horizon cutoff.
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
- `gh-delta/contract`: runtime contract constants (`REPORT_SCHEMA_VERSION`,
  `OUTPOST_SCHEMA_VERSION`, `DELTA_CLASSES`, `ERROR_KINDS`).

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

When neither `--state-dir` nor `--state-file` is given, the default directory is:

```text
<os.tmpdir()>/gh-delta-<encoded user>/
```

and the snapshot path follows the same `repo-<encoded repo>__monitor-<encoded monitor-id>__<entities>.json`
pattern inside it. This default is **ephemeral**: reboots or tmp cleanup silently
re-seed the baseline. Scheduled or durable monitors must pass an explicit
`--state-dir`.

Filename segment encoding uses `encodeURIComponent` **with `_` additionally
encoded as `%5F`** so that the `__` separator is unambiguous — derived names are
injective for all valid CLI inputs. Library callers passing raw entity strings
containing `__` to `snapshotPath` directly are outside this guarantee.

`--state-file` bypasses path derivation for operators that need a fully explicit
path, but `--monitor-id` is still required because reports and outpost event IDs
use it.

## GitHub Fetch Contract

All fetches use `gh api graphql` with UPDATED_AT DESC pagination. There are no
`gh pr list` or `gh issue list` subprocess calls.

**Incremental fetch strategy (per family: PR and issue):**

1. **Open-items phase** — fetch all OPEN items, walking pages until exhausted or
   the page cap is reached (10 pages × 100 = 1 000 items max). Fails closed with
   exit `1` if the cap is exceeded.
2. **Updated-items phase** (incremental only; skipped on baseline) — fetch
   ALL-states items ordered by UPDATED_AT DESC, stopping at the snapshot horizon
   minus a 5-minute overlap. Walking more than 30 pages × 100 = 3 000 items
   fails closed with exit `1` and the message "narrow the monitor scope or
   re-seed the baseline".

Open-items results and updated-items results are merged: the open-items phase
wins on duplicates (an open item appearing in both is only counted once from the
open-items pass).

**Fail-closed per-item nested pagination:** each PR node is checked for page
overflow on `statusCheckRollup.contexts`, `latestReviews`, and `reviewThreads`.
Each issue node is checked on `labels`. Any overflow is a hard error (exit `1`).

**Comment counts** come from GraphQL `totalCommentsCount` (PRs) and
`comments { totalCount }` (issues) — exact integers with no cap or overflow flag.

The PR fingerprint tracks:

- state
- updated timestamp
- draft status
- canonicalized CI rollup hash
- review decision
- latest review state hash
- mergeability
- exact comment total
- review thread count
- unresolved review thread count
- head SHA

The issue fingerprint tracks:

- state
- updated timestamp
- sorted labels
- exact comment total

## Snapshot Contract

Snapshots are plain JSON with shape `{ "pr": object, "issue": object, "meta"?: object }`:

```json
{
  "pr": {
    "42": {
      "state": "OPEN",
      "updatedAt": "2026-07-01T10:00:00Z"
    }
  },
  "issue": {},
  "meta": {
    "horizon": "2026-07-01T12:00:00.000Z"
  }
}
```

`meta.horizon` is stamped with the run timestamp on every successful write and
used as the starting point for the incremental-fetch horizon (minus 5 minutes of
overlap). Legacy snapshots without `meta` fall back to the newest `updatedAt`
across stored fingerprints.

Missing snapshots are treated as a first run (baseline). Corrupt snapshot JSON
or an invalid shape is a permanent error: the command exits `2` and leaves the
snapshot untouched. This prevents a corrupt file from silently erasing monitor
memory.

Write-side validation runs before the rename — a snapshot the reader would
reject is never persisted. The temporary file is removed on rename failure to
avoid leaving stray `.tmp` files.

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
is attempted for exit `0`, `1`, or `2`.

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

Transient errors (kind `github` or `io`) exit `1`; permanent errors (kind
`config` or `snapshot`) exit `2`. In both cases the snapshot is not written.
This prevents transient network or rate-limit failures from erasing the previous
known-good baseline, and permanent errors signal that human intervention is
required before retrying.

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

`missing` fires when an item the snapshot believes OPEN disappears from the
fetch. Absent closed items are dormant memory, not a missing delta. The old
fingerprint is retained so the watcher does not silently lose memory.

`still-missing` fires on the second tick that the item remains absent. This lets
agents distinguish first sighting from unresolved operational state.

`presumed-deleted` fires on the third consecutive tick (terminal, emitted once).
After that the item goes silent with memory intact: `missingTicks` increments but
no delta is emitted. `reappeared` still fires if the item returns.
