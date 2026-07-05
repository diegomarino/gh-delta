# gh-delta Contract

Canonical, machine-facing contract for `gh-delta`. Other docs link here; do not
duplicate these tables elsewhere (the one exception is the self-contained prompt
in `docs/watch-loop-prompt.md`).

This contract is stable for the `0.1` line. `report.schemaVersion` identifies the
report shape at runtime (see [Report Shape](#report-shape)). The machine-readable
form of this document is available at `gh-delta --help-json`.

## CLI

```
gh-delta --repo <owner/name> --monitor-id <id>
         [--state-file <path> | --state-dir <dir>]
         [--entities pr,issue] [--format json|text] [--detail]
         [--outpost-url <url>]
         [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>]
         [--gh-timeout-ms <ms>]
```

- `--repo` and `--monitor-id` are required.
- `--repo` must be `owner/name`. **Canonicalized to lowercase** — snapshot paths,
  report echoes, and outpost event IDs always use the lowercased form.
- `--monitor-id` must start with a letter or number and contain only letters,
  numbers, dot, underscore, or dash.
- `--state-file` and `--state-dir` are mutually exclusive and **optional**. When
  neither is given, the snapshot lives at
  `<system temp dir>/gh-delta-<user>/repo-<repo>__monitor-<id>__<entities>.json`;
  the directory is per-user (`0700`) and **ephemeral** — reboots and tmp cleanup
  silently re-seed the baseline; pass `--state-dir` explicitly for durable
  monitors. `--state-file` is an explicit snapshot path; `--state-dir` derives a
  path scoped by repo, monitor id, and selected entities (see
  [Snapshot Semantics](#snapshot-semantics)). Both together exit `2` (config).
- `--entities` defaults to `pr,issue`. Accepted: `pr`, `issue`, `pr,issue`.
- `--format` defaults to `json`. `text` is an operator/log mode, not a machine
  contract; automated consumers must use `json`.
- `--detail` adds a human-readable `line` to each delta in JSON output.
- `--outpost-url` is optional at-most-once HTTP delivery; see
  [Outpost Payload](#outpost-payload-schema-v1). It does not affect the JSON
  report, exit code, or snapshot.
- `--outpost-timeout-ms` timeout in milliseconds for each outpost HTTP POST
  (default `4000`).
- `--outpost-max-posts` maximum number of outpost POSTs per run (default:
  unlimited). Excess deltas are skipped with an outpost warning.
- `--gh-timeout-ms` timeout in milliseconds for each `gh` subprocess call
  (default `60000`).

**Repeated flags:** the last value wins. **`--help`, `--help-json`, and
`--version` take precedence over all validation** — an agent probing with
`--help-json` receives the help document even when the rest of the command line
is invalid.

## Exit Codes

- `0`: baseline established or no deltas.
- `10`: deltas found.
- `1`: **transient error** — GitHub CLI, network, timeout, or snapshot write
  failure. The snapshot is not updated; the next scheduled tick should retry
  automatically.
- `2`: **permanent error** — invalid configuration or unreadable / invalid-shape
  snapshot. Retrying will not help; a human must fix the issue before the next
  tick.

## Programmatic API Surface

The package publishes a small, explicit ESM surface. Imports must use explicit
subpaths; the package root is intentionally not exported.

| Export path            | Symbols                                                                           | Purpose                               |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `gh-delta/detect`      | `detectDeltas`                                                                    | Pure delta classification engine      |
| `gh-delta/fingerprint` | `canonicalizeCiRollup`, `hashReviews`, `issueFingerprint`, `prFingerprint`        | Stable object fingerprint builders    |
| `gh-delta/outpost`     | `buildOutpostPayload`, `postOutpost`, `sendOutposts`, `validateOutpostUrl`        | Outpost payload and transport helpers |
| `gh-delta/snapshot`    | `readSnapshot`, `snapshotPath`, `writeSnapshotAtomic`, `defaultStateDir`          | Snapshot path and persistence helpers |
| `gh-delta/args`        | `parseEntitySelection`, `validateRepo`, `validateMonitorId`, `canonicalEntityKey` | Shared argument parsing policies      |
| `gh-delta/version`     | `getPackageMetadata`, `renderVersionText`                                         | Package metadata and version output   |
| `gh-delta/contract`    | `REPORT_SCHEMA_VERSION`, `OUTPOST_SCHEMA_VERSION`, `DELTA_CLASSES`, `ERROR_KINDS` | Runtime contract constants            |

Behavioral notes for consumers:

- `detectDeltas` is pure: pass old and current collections and consume
  `baseline`, `deltas`, and replacement `snapshot`.
- `buildOutpostPayload` already includes deterministic `eventId` and `deliveryId`.
- `postOutpost` throws on HTTP failures so callers can classify transport errors.
- `readSnapshot` throws on malformed JSON; callers should treat this as
  recoverable only via explicit snapshot reset.
- `snapshotPath` is deterministic and scoped by repo, monitor-id, and entity set.

The exit code is the primary machine signal. Branch on it before reading stdout:
codes `1` and `2` produce an [error report](#error-report-shape) with no
`deltas` field.

## Delta Classes

Closed set for the `0.1` line. Every delta carries at least one class; `classes`
is **never empty** (`updated` is the catch-all). `classes` is a **set** — several
can co-occur on one delta (e.g. `ci-changed` + `review-changed`). Order within
the array is not significant and not guaranteed stable.

| Class                         | Applies to | Meaning                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`                         | pr, issue  | New issue or PR after the baseline. `from` is `null`.                                                                                                                                                                                                            |
| `closed`                      | pr, issue  | Issue or PR was closed.                                                                                                                                                                                                                                          |
| `reopened`                    | pr, issue  | Issue or PR was reopened (state returned to `OPEN`).                                                                                                                                                                                                             |
| `new-comments`                | pr, issue  | Comment count increased.                                                                                                                                                                                                                                         |
| `updated`                     | pr, issue  | Fingerprint changed with no more specific class. A PR-branch push alone (head SHA change) surfaces here.                                                                                                                                                         |
| `missing`                     | pr, issue  | An item the snapshot believes OPEN vanished from the fetch. Check pagination, permissions, or scope before trusting it. Absent closed items are dormant memory, not a missing delta. `to` is `null`.                                                             |
| `still-missing`               | pr, issue  | An already-missing open item is still absent (tick 2). Unresolved operational state, not a fresh delta. `to` is `null`.                                                                                                                                          |
| `presumed-deleted`            | pr, issue  | Absent for 3 consecutive ticks; treated as deleted, transferred, or converted. Emitted once; the object then goes silent but stays in memory (`missingTicks` counter in the stored fingerprint). `reappeared` still fires if the object returns. `to` is `null`. |
| `reappeared`                  | pr, issue  | An object previously marked `missing` returned to the fetch. It may co-occur with other classes if the fingerprint also changed.                                                                                                                                 |
| `merged`                      | pr only    | PR was merged.                                                                                                                                                                                                                                                   |
| `draft-ready`                 | pr only    | PR moved from draft to ready for review.                                                                                                                                                                                                                         |
| `ci-changed`                  | pr only    | Check run or status context changed.                                                                                                                                                                                                                             |
| `review-changed`              | pr only    | Review decision or latest review states changed.                                                                                                                                                                                                                 |
| `became-mergeable`            | pr only    | PR moved from `CONFLICTING` to `MERGEABLE` (an `UNKNOWN` mid-recompute placeholder does not count).                                                                                                                                                              |
| `unresolved-threads-added`    | pr only    | Unresolved PR review thread count increased.                                                                                                                                                                                                                     |
| `unresolved-threads-resolved` | pr only    | Unresolved PR review thread count decreased.                                                                                                                                                                                                                     |
| `review-threads-changed`      | pr only    | PR review thread total changed while the unresolved count held steady.                                                                                                                                                                                           |
| `relabeled`                   | issue only | Issue labels changed. (The PR fetch does not collect labels, so PRs never emit this.)                                                                                                                                                                            |

**Forward compatibility:** new classes may be added in a later minor version.
Consumers must treat an unrecognized class as "something changed, inspect,"
never as an error. See also [schemaVersion policy](#schemaversion-policy).

## Report Shape

Success reports (exit `0` and `10`):

```json
{
  "schemaVersion": 1,
  "baseline": false,
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "entities": ["pr"],
  "stateFile": "/tmp/gh-delta-user/repo-owner%2Frepo__monitor-prs-5m__pr.json",
  "at": "2026-07-01T12:00:00.000Z",
  "deltas": [
    {
      "entity": "pr",
      "number": 42,
      "title": "Add widget",
      "classes": ["ci-changed", "review-changed"],
      "from": {},
      "to": {},
      "line": "PR #42 \"Add widget\": ci-changed, review-changed"
    }
  ],
  "summary": "1 delta(s)"
}
```

Field guarantees:

- `schemaVersion` (number): report shape version. Bumped **only** on a breaking
  change — a field removed or renamed. Additive changes (new optional keys on the
  report, a delta, or a fingerprint) do not bump it. Assert `schemaVersion === 1`.
- `baseline` (boolean): `true` on the first run for a snapshot. When `true`,
  `deltas` is always `[]` even though every tracked object is new — a baseline
  seeds memory, it does not report. Handle it distinctly from "no deltas."
- `repo`, `monitorId` (string): echo the flags.
- `entities` (string[]): the selected families, always in canonical order
  `["pr", "issue"]` regardless of the `--entities` input order.
- `stateFile` (string): the resolved snapshot path — useful when the temp-dir
  default is in effect.
- `at` (string): ISO-8601 UTC timestamp of the run.
- `summary` (string): **human-readable only.** Wording is not stable; do not
  parse it (it varies between "baseline established: N PRs, M issues" and
  "N delta(s)").
- `deltas` (array): see below. Empty on baseline and on no-change runs.
- `warnings` (`{ label: string, reason: string }[]`): **optional; present only in JSON format when outpost
  delivery produced warnings** (e.g. a POST timed out or returned an error).
  Omitted entirely when there are no warnings. Does not appear in text output
  (warnings are printed inline there). Does not affect the exit code.

Each delta:

- `entity` (`"pr"` | `"issue"`): the **only** discriminator between an issue and
  a PR. GitHub numbers are shared across issues and PRs, so `number` alone is
  ambiguous — always key on `(entity, number)`.
- `number` (number), `title` (string): GitHub identity. For `missing` /
  `still-missing` / `presumed-deleted` deltas `title` is the sentinel string
  `"(missing from current fetch)"`, not the real title.
- `classes` (string[]): non-empty set of [classes](#delta-classes).
- `from`, `to`: entity [fingerprints](#fingerprint-fields), or `null`. `from` is
  `null` when `classes` includes `new`; `to` is `null` when `classes` includes
  `missing` or `still-missing`.
- `line` (string): present **only** with `--detail`.

**Ordering:** within a report, PR deltas precede issue deltas; within each family
the order follows the GitHub fetch result. Do not rely on positional access
(`deltas[0]`) or on a stable within-family order across GitHub API changes.

### Fingerprint fields (`from` / `to`)

The fingerprint is the detector's stable-shaped but **semi-opaque** change-detection
subset. Prefer `classes` as the semantic diff — the fingerprint exists mainly to
read concrete current values and for context. The field **set is additive**;
consumers must tolerate new keys and must not assume a closed shape.

PR fingerprint:

| Field                     | Readable?   | Notes                                                                                         |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `state`                   | yes         | `OPEN` \| `CLOSED` \| `MERGED`.                                                               |
| `updatedAt`               | yes         | ISO-8601.                                                                                     |
| `isDraft`                 | yes         | boolean.                                                                                      |
| `mergeable`               | yes         | `MERGEABLE` \| `CONFLICTING` \| `UNKNOWN`.                                                    |
| `review`                  | yes         | GitHub `reviewDecision` (e.g. `APPROVED`, `REVIEW_REQUIRED`, `""`).                           |
| `comments`                | yes         | exact integer total from GraphQL `totalCommentsCount`.                                        |
| `reviewThreads`           | yes         | integer count of PR review threads.                                                           |
| `unresolvedReviewThreads` | yes         | integer count of unresolved PR review threads.                                                |
| `ci`                      | **opaque**  | sha1 digest of the CI rollup. Observe inequality only; never parse.                           |
| `reviews`                 | **opaque**  | sha1 digest of latest reviews. Observe inequality only; never parse.                          |
| `head`                    | opaque-ish  | head ref OID (git SHA). Treat as a change indicator; every push changes it.                   |
| `missing`                 | bookkeeping | boolean; present on fingerprints stored for missing items. Not part of the change comparison. |
| `missingTicks`            | bookkeeping | number; consecutive ticks an item has been absent. Present alongside `missing: true`.         |

Issue fingerprint: `state`, `updatedAt`, `labels` (string[], sorted),
`comments` (exact integer total from GraphQL `totalCount`).

When an item is missing, `missing: true` and `missingTicks` are written into the
stored fingerprint so the lifecycle (`missing` → `still-missing` →
`presumed-deleted`) can advance across ticks. These bookkeeping fields are
present in the `from` fingerprint of `missing`, `still-missing`, and
`presumed-deleted` deltas and are stripped before change comparison.

### Error Report Shape

Emitted with exit code `1` (transient) or `2` (permanent). It **does not** carry
`deltas`, `baseline`, `entities`, or `summary`. The snapshot is not written.

```json
{
  "schemaVersion": 1,
  "error": "missing required --repo <owner/name>",
  "kind": "config",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "at": "2026-07-01T12:00:00.000Z"
}
```

- `schemaVersion` (number), `error` (string), `at` (string): always present.
- `kind` (string): one of `config`, `snapshot`, `github`, `io`. This is a closed
  set for `0.1` but forward-compatible like classes — treat unknown values as
  "something changed, inspect". `config` and `snapshot` kinds map to exit `2`;
  `github` and `io` kinds map to exit `1`.
- `repo`, `monitorId` (string): present once the corresponding flag has been
  parsed (absent for errors raised before that, e.g. an unknown option). `error`
  strings are human-readable and not a stable enum.

## Snapshot Semantics

The detector is stateless between runs except for the snapshot it owns.

**Incremental fetch contract:** open items are always fetched in full (the scope
for missing detection). When a prior snapshot exists, `meta.horizon` (the
timestamp of the previous run) minus a 5-minute overlap is used as a cutoff:
all-states items updated since that cutoff are also fetched to observe closed,
merged, and relabeled transitions. Absent closed items are dormant memory, not a
missing delta — only items the snapshot believes OPEN can vanish.

Snapshot shape: `{ "pr": object, "issue": object, "meta"?: object }`.
`meta.horizon` is stamped with the run timestamp on every successful write.
Legacy snapshots without `meta` fall back to the newest `updatedAt` across all
stored fingerprints as the horizon.

- The consumer supplies the snapshot **location**, never snapshot **data**.
  gh-delta reads it, diffs, and atomically rewrites it after a successful fetch.
- The **first run** (no snapshot file) seeds a baseline: exit `0`,
  `baseline: true`, `deltas: []`. Persist the state directory between runs (or accept the ephemeral temp default's silent re-baseline).
- Snapshot JSON is strict. A missing file seeds a baseline, but any present file
  that is not `{ "pr": object, "issue": object }` with numeric object keys is an
  error (exit `2`) and is not migrated. Write-side validation runs before the
  rename so a bad snapshot is never persisted. The temp file is removed on rename
  failure to avoid leaving stray files.
- A derived `--state-dir` path is scoped by repo, monitor id, **and** selected
  entities. A `--entities pr` run and a `--entities pr,issue` run use **different**
  files; keep `--entities` fixed per monitor so state is not split.
- Filename segments are encoded with `encodeURIComponent` **plus `_` additionally
  encoded as `%5F`**, making derived names injective for CLI inputs. Library
  callers passing raw entity strings containing `__` to `snapshotPath` directly
  are outside this guarantee.
- A partial `--entities` run preserves the omitted family's memory in the
  snapshot; it does not erase it.
- **Do not run concurrent ticks against the same state file.** Writes are atomic
  (temp file + rename), which prevents corruption, but overlapping runs still
  race and one will clobber the other's result. Serialize ticks per
  `(repo, monitor-id, entities)`.

### schemaVersion policy

`schemaVersion` is bumped **only** on a breaking change — a field renamed or
removed. **Additive changes** (new optional fields on the report, a delta, or a
fingerprint; new classes; new error kinds) **never bump `schemaVersion`.**
Unknown classes or kinds mean "something changed, inspect", never an error.
Assert `schemaVersion === 1` and handle unknown classes/kinds gracefully.

## Outpost Payload (schema v1)

One JSON `POST` per delta when the detector exits `10` and `--outpost-url` is set.
`from` and `to` are the entity fingerprint objects, or `null` when there is no
prior/next state (`from` is `null` for a `new` object; `to` is `null` for a
`missing` object).

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:prs-5m:pr:42:new",
  "deliveryId": "gh-delta.delivery.v1:owner/repo:prs-5m:pr:42:new:2026-07-01T12:00:00.000Z",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "detectedAt": "2026-07-01T12:00:00.000Z",
  "entity": "pr",
  "number": 42,
  "title": "Add widget",
  "classes": ["new"],
  "state": "OPEN",
  "labels": [],
  "line": "PR #42 \"Add widget\": new",
  "delta": { "from": null, "to": {} },
  "links": { "html": "https://github.com/owner/repo/pull/42" }
}
```

Outpost is best-effort notification. `eventId` is stable for the semantic delta
and is the receiver's dedupe key. `deliveryId` includes the detector timestamp
and identifies one delivery attempt. `gh-delta` does not provide reliable
delivery, retries, an outbox, acknowledgement, or replay in `0.1`. Classes are
sorted before they are joined into the ids, so semantic identity is independent
of the order the classifier emitted them. PR payloads currently use an empty
`labels` array because the PR fetch does not collect labels.
