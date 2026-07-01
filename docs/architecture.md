# Architecture

`gh-delta` is intentionally narrow: it turns `(old snapshot, current GitHub state)`
into a categorized JSON delta report. It does not schedule itself, open browser
sessions, merge pull requests, or send messages to workers.

## Boundaries

```text
watch loop / timer
  -> gh-delta.mjs
      -> lib/gh.mjs        fetch current GitHub state with gh
      -> lib/snapshot.mjs  read previous snapshot
      -> lib/detect.mjs    compare old and current fingerprints
      -> lib/snapshot.mjs  atomically write new snapshot
      -> lib/outpost.mjs   optional HTTP POST per delta
  -> caller decides what to do with deltas
```

Scheduled agent loops normally call `gh-delta-tick.mjs` instead. That wrapper
uses `gh-delta.mjs`, then formats heartbeat text and suggested next actions so
each cron fire can stay short and stateless.

The core correctness logic is pure:

- `fingerprint.mjs` converts GitHub objects into stable fingerprints.
- `detect.mjs` compares fingerprints and emits delta classes.

The impure edges are isolated:

- `gh.mjs` shells out to `gh`.
- `snapshot.mjs` performs filesystem I/O.
- `outpost.mjs` validates optional outpost URLs, builds schema v1 payloads, and
  sends short-timeout HTTP POSTs.
- `gh-delta.mjs` parses CLI flags and maps results to exit codes.
- `gh-delta-tick.mjs` formats one scheduler-owned tick for agents/operators.

## GitHub Fetch Contract

PRs are fetched with `--state all --limit 500`. Both flags matter:

- `--state all` keeps merged and closed PRs observable. Without it, a merged PR can
  disappear from the result set and become indistinguishable from scope loss.
- `--limit 500` avoids the default low limit hiding older PRs or issues. It is
  not full pagination. If GitHub returns exactly 500 PRs or issues, `gh-delta`
  exits `1` without writing the snapshot because the watch scope may be
  truncated.

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
- head SHA

The issue fingerprint tracks:

- state
- updated timestamp
- sorted labels
- comment count
- comment-array overflow flag

GitHub CLI list commands expose comment arrays, not GraphQL `totalCount` fields.
When those arrays reach the observed cap, `gh-delta` treats an `updatedAt` bump as
`new-comments` instead of degrading it to plain `updated`. This is intentionally
conservative until a future GraphQL fetcher can use exact totals for issue
comments, PR conversation comments, reviews, and review threads.

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
file from silently erasing watcher memory.

Writes are atomic for a single writer: the snapshot is written to a unique
temporary file beside the target, then renamed into place. Do not run overlapping
ticks against the same state file; use scheduler-level locking if overlap is
possible.

Successful detections are at-most-once from the detector's perspective. The
snapshot advances before an agent acts on deltas and before optional outpost
delivery is attempted. Operators that need at-least-once action delivery should
persist the detector output or add an external pending/ack queue.

## Outpost Contract

`--outpost-url` is an optional edge on `gh-delta.mjs` and `gh-delta-tick.mjs`.
It is not part of `lib/detect.mjs`; the detector still only returns facts.

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

Failures are warnings, not detector failures. A timeout, DNS failure, HTTP
`4xx`, or HTTP `5xx` does not alter the detector or tick exit code and does not
cause another snapshot write.

Schema v1 payloads use this envelope:

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:watch:issue:17:relabeled:2026-07-01T12:00:00.000Z",
  "repo": "owner/repo",
  "branch": "watch",
  "detectedAt": "2026-07-01T12:00:00.000Z",
  "entity": "issue",
  "number": 17,
  "title": "Backfill imports",
  "classes": ["relabeled"],
  "state": "OPEN",
  "labels": ["worker", "backend"],
  "line": "ISSUE #17 \"Backfill imports\": relabeled",
  "delta": {
    "from": {},
    "to": {}
  },
  "links": {
    "html": "https://github.com/owner/repo/issues/17"
  }
}
```

`eventId` is deterministic from repo, branch, entity, number, class list, and the
detector timestamp. The external endpoint owns filtering, deduplication, and
actions.

## Error Contract

If fetching or parsing fails, `gh-delta` exits `1` and does not write the snapshot.
This keeps transient network or rate-limit failures from erasing the previous
known-good baseline.

## Delta Classification

Each changed object can emit one or more classes:

- `new`
- `closed`
- `reopened`
- `merged`
- `draft-ready`
- `ci-changed`
- `review-changed`
- `became-mergeable`
- `new-comments`
- `relabeled`
- `missing`
- `still-missing`
- `updated`

`updated` is the recall-over-precision fallback. It fires when the fingerprint
changed but no more specific class matched.

`missing` fires when a previously known object disappears from a fetched
collection. The old fingerprint is retained so the watcher does not silently lose
memory if GitHub output was truncated or scoped unexpectedly.

`still-missing` fires on later ticks when that same retained object remains
absent. This lets agents distinguish first sighting from unresolved operational
state.
