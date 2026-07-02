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
         (--state-file <path> | --state-dir <dir>)
         [--entities pr,issue] [--format json|text] [--detail]
         [--outpost-url <url>]
```

- `--repo` and `--monitor-id` are required.
- `--state-file` and `--state-dir` are mutually exclusive, and exactly one is
  required. `--state-file` is an explicit snapshot path; `--state-dir` derives a
  path scoped by repo, monitor id, and selected entities (see
  [Snapshot Semantics](#snapshot-semantics)).
- `--entities` defaults to `pr,issue`. Accepted: `pr`, `issue`, `pr,issue`.
- `--format` defaults to `json`. `text` is an operator/log mode, not a machine
  contract; automated consumers must use `json`.
- `--detail` adds a human-readable `line` to each delta in JSON output.
- `--outpost-url` is optional at-most-once HTTP delivery; see
  [Outpost Payload](#outpost-payload-schema-v1). It does not affect the JSON
  report, exit code, or snapshot.

## Exit Codes

- `0`: baseline established or no deltas.
- `10`: deltas found.
- `1`: argument, GitHub CLI, network, or parse error. On errors, the snapshot is
  not updated.

The exit code is the primary machine signal. Branch on it before reading stdout:
code `1` produces an [error report](#error-report-shape) with no `deltas` field.

## Delta Classes

Closed set for the `0.1` line. Every delta carries at least one class; `classes`
is **never empty** (`updated` is the catch-all). `classes` is a **set** — several
can co-occur on one delta (e.g. `ci-changed` + `review-changed`). Order within
the array is not significant and not guaranteed stable.

| Class                         | Applies to | Meaning                                                                                                                                |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `new`                         | pr, issue  | New issue or PR after the baseline. `from` is `null`.                                                                                  |
| `closed`                      | pr, issue  | Issue or PR was closed.                                                                                                                |
| `reopened`                    | pr, issue  | Issue or PR was reopened (state returned to `OPEN`).                                                                                   |
| `new-comments`                | pr, issue  | Comment count increased (or, at the 100-comment cap, `updatedAt` advanced).                                                            |
| `updated`                     | pr, issue  | Fingerprint changed with no more specific class. A PR-branch push alone (head SHA change) surfaces here.                               |
| `missing`                     | pr, issue  | An object from the prior snapshot vanished from the fetch. Check pagination, permissions, or scope before trusting it. `to` is `null`. |
| `still-missing`               | pr, issue  | An already-missing object is still absent. Unresolved operational state, not a fresh item. `to` is `null`.                             |
| `merged`                      | pr only    | PR was merged.                                                                                                                         |
| `draft-ready`                 | pr only    | PR moved from draft to ready for review.                                                                                               |
| `ci-changed`                  | pr only    | Check run or status context changed.                                                                                                   |
| `review-changed`              | pr only    | Review decision or latest review states changed.                                                                                       |
| `became-mergeable`            | pr only    | PR moved from `CONFLICTING` to `MERGEABLE` (an `UNKNOWN` mid-recompute placeholder does not count).                                    |
| `unresolved-threads-added`    | pr only    | Unresolved PR review thread count increased.                                                                                           |
| `unresolved-threads-resolved` | pr only    | Unresolved PR review thread count decreased.                                                                                           |
| `review-threads-changed`      | pr only    | PR review thread total changed while the unresolved count held steady.                                                                 |
| `relabeled`                   | issue only | Issue labels changed. (The PR fetch does not collect labels, so PRs never emit this.)                                                  |

**Forward compatibility:** new classes may be added in a later minor version.
Consumers must treat an unrecognized class as "something changed, inspect,"
never as an error.

## Report Shape

Success reports (exit `0` and `10`):

```json
{
  "schemaVersion": 1,
  "baseline": false,
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "entities": ["pr"],
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
- `at` (string): ISO-8601 UTC timestamp of the run.
- `summary` (string): **human-readable only.** Wording is not stable; do not
  parse it (it varies between "baseline established: N PRs, M issues" and
  "N delta(s)").
- `deltas` (array): see below. Empty on baseline and on no-change runs.

Each delta:

- `entity` (`"pr"` | `"issue"`): the **only** discriminator between an issue and
  a PR. GitHub numbers are shared across issues and PRs, so `number` alone is
  ambiguous — always key on `(entity, number)`.
- `number` (number), `title` (string): GitHub identity. For `missing` /
  `still-missing` deltas `title` is the sentinel string
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

| Field                     | Readable?  | Notes                                                                                                                                 |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                   | yes        | `OPEN` \| `CLOSED` \| `MERGED`.                                                                                                       |
| `updatedAt`               | yes        | ISO-8601.                                                                                                                             |
| `isDraft`                 | yes        | boolean.                                                                                                                              |
| `mergeable`               | yes        | `MERGEABLE` \| `CONFLICTING` \| `UNKNOWN`.                                                                                            |
| `review`                  | yes        | GitHub `reviewDecision` (e.g. `APPROVED`, `REVIEW_REQUIRED`, `""`).                                                                   |
| `comments`                | yes        | integer count, **saturates at 100**. At the cap, use `commentsOverflow` and `updatedAt`, not the raw count, to reason about activity. |
| `commentsOverflow`        | yes        | boolean; `true` once `comments` hit the 100 cap.                                                                                      |
| `reviewThreads`           | yes        | integer count of PR review threads.                                                                                                   |
| `unresolvedReviewThreads` | yes        | integer count of unresolved PR review threads.                                                                                        |
| `ci`                      | **opaque** | sha1 digest of the CI rollup. Observe inequality only; never parse.                                                                   |
| `reviews`                 | **opaque** | sha1 digest of latest reviews. Observe inequality only; never parse.                                                                  |
| `head`                    | opaque-ish | head ref OID (git SHA). Treat as a change indicator; every push changes it.                                                           |

Issue fingerprint: `state`, `updatedAt`, `labels` (string[], sorted),
`comments` (same 100 cap), `commentsOverflow`.

### Error Report Shape

Emitted with exit code `1`. It **does not** carry `deltas`, `baseline`,
`entities`, or `summary`. The snapshot is not written.

```json
{
  "schemaVersion": 1,
  "error": "missing required --repo <owner/name>",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "at": "2026-07-01T12:00:00.000Z"
}
```

- `schemaVersion` (number), `error` (string), `at` (string): always present.
- `repo`, `monitorId` (string): present once the corresponding flag has been
  parsed (absent for errors raised before that, e.g. an unknown option). `error`
  strings are human-readable and not a stable enum.

## Snapshot Semantics

The detector is stateless between runs except for the snapshot it owns. There is
**no `--since` and no incremental mode**: every run fetches the full requested
collections from GitHub and diffs them against the snapshot at the
`--state-file` / `--state-dir` location.

- The consumer supplies the snapshot **location**, never snapshot **data**.
  gh-delta reads it, diffs, and atomically rewrites it after a successful fetch.
- The **first run** (no snapshot file) seeds a baseline: exit `0`,
  `baseline: true`, `deltas: []`. Persist the state directory between runs.
- A derived `--state-dir` path is scoped by repo, monitor id, **and** selected
  entities. A `--entities pr` run and a `--entities pr,issue` run use **different**
  files; keep `--entities` fixed per monitor so state is not split.
- A partial `--entities` run preserves the omitted family's memory in the
  snapshot; it does not erase it.
- **Do not run concurrent ticks against the same state file.** Writes are atomic
  (temp file + rename), which prevents corruption, but overlapping runs still
  race and one will clobber the other's result. Serialize ticks per
  `(repo, monitor-id, entities)`.

## Outpost Payload (schema v1)

One JSON `POST` per delta when the detector exits `10` and `--outpost-url` is set.
`from` and `to` are the entity fingerprint objects, or `null` when there is no
prior/next state (`from` is `null` for a `new` object; `to` is `null` for a
`missing` object).

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:prs-5m:pr:42:new:2026-07-01T12:00:00.000Z",
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

`eventId` is deterministic for a given repo, monitor id, entity, number, class
set, and detector timestamp. Classes are sorted before they are joined into the
id, so it is independent of the order the classifier emitted them. PR payloads
currently use an empty `labels` array because the PR fetch does not collect
labels.
