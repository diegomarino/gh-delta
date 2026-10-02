# Delta fields and details

[Documentation](../README.md) · [Contract reference](../contract.md)

These fields belong to each delta in the [report envelope](report.md#report-shape).

Each delta — see `DELTA_FIELDS` in `gh-delta/contract`:

- `repo` (string, optional): present only in a multi-repository aggregate,
  identifying the repository that produced the delta.
- `id` (string): a 64-character lowercase sha256 hex **content hash of the
  observed change's identity**, present on every delta. It hashes
  `{ repo, entity, number, to }` for an observed entity, or
  `{ repo, entity, number, from, classes, missingTicks }` when `to` is `null`
  (the missing lifecycle). It is **stable across runs and across monitors** and
  deliberately **excludes `monitorId`**, the report `detectedAt`, `context.title`,
  and every derived display field — so two monitors observing the same current
  GitHub state emit the same `id`. Use it as the idempotency key for dedupe.
  Ids are stable **per gh-delta version**: a release that adds compared
  fingerprint fields shifts each item's id once on its first post-upgrade
  delta, and monitors on different versions emit different ids for the same
  observation — upgrade co-posting monitors together to keep cross-monitor
  dedupe intact.
- `entity` (`"pr"` | `"issue"`): the **only** discriminator between an issue and
  a PR. GitHub numbers are shared across issues and PRs, so `number` alone is
  ambiguous — always key on `(entity, number)`.
- `number` (number): GitHub identity.
- `context` (object): identity/display fields, never compared and never hashed
  into `id`. See `DELTA_CONTEXT_FIELDS` in `gh-delta/contract`:
  - `id` (string|null): the GitHub GraphQL node id.
  - `title` (string|null): on the missing lifecycle (`to === null`) this is
    the **last-known** title from the snapshot, which may be stale since it
    cannot be reconfirmed without a successful fetch.
  - `url` (string|null): the GitHub web URL.
  - `author` (string|null): the login, or `null` for a deleted/ghost account.
  - `createdAt` (string|null): ISO-8601.
  - `headRefName` (string|null): **PR context only** — the PR's head branch
    name. It is **not** a change signal: renaming the branch alone never
    produces a delta. GitHub keeps `headRefName` (a non-null `String!`) even
    after the branch is deleted at merge, so it is effectively always a
    non-empty string on PR context that has a current object — a `merged`
    delta still carries its (now-deleted) branch, so you can route on it.
    **Absent** (the key itself, not just `null`) on issue context.

  > Note: gh-delta does **not** identify branch deletion as such — deletion
  > changes neither `headRefName` nor the head SHA (both retained by GitHub).
  > GitHub does bump the PR's `updatedAt` when the head branch is deleted, so
  > within the horizon window the deletion surfaces as an opaque `updated`
  > delta; query the head ref directly (null once deleted) to attribute it.
  > `headRefName` is purely "which branch", never "does the branch still exist".

- `classes` (string[]): non-empty set of [classes](delta-classes.md#delta-classes).
- `changed` (object): always present. A bounded, pure diff of the fingerprint
  fields that moved between `from` and `to` — see `diffFingerprint` in
  [Programmatic API Surface](programmatic-api.md#programmatic-api-surface) for the exact
  per-field-kind shape (scalar `{from,to}`, set `{added,removed}`,
  identity-keyed `{added,removed,changed}` by row id, `checks`'
  `{failed,fixed,changed}` by check name). Every array result caps at 20
  entries (`truncated: true` past that).
- `summary` (object): always present. For a PR with an observed `to` state, a
  normalized, typed semantic view of the current state — see
  [Delta Summary schema](summary.md#delta-summary-schema). For an issue with an observed
  `to` state, only `{state}`. For the missing lifecycle (`to === null`), `null`.
  It is a **sibling** of `to`, not nested inside it, so it never affects `id`.
  `--summaries` is a deprecated no-op now that this is unconditional.
- `from`, `to` (object|null): the compared **bare fingerprint** (see
  [Fingerprint fields](fingerprints.md#fingerprint-fields-from--to)) — never the full
  `{fingerprint, context, meta}` snapshot item. `context` is never duplicated
  here: it already lives at the delta's own top level (see the `context`
  bullet above), and `delta.id` hashes exactly `to` (see `deltaIdentity` in
  [Programmatic API Surface](programmatic-api.md#programmatic-api-surface)), so `to` here is
  precisely what the id is a hash of. Always present in `--format json`;
  present in compact/ndjson only under `--full`. `from` is `null` when
  `classes` includes `new` or `first-seen`; `to` is `null` when `classes`
  includes `missing`, `still-missing`, or `presumed-deleted`.
- `missingTicks` (number): present on `missing`, `still-missing`, and
  `presumed-deleted` deltas. It is the current consecutive absent tick.
- `firstObserved` (boolean, optional): present and `true` **only** on `new`,
  `first-seen`, and `baseline-state` deltas (never `false` — present or
  absent). A fact about this occurrence, derived from `classes`; it is
  declared in the schema but never `required`, and it never enters `id`.
- `seq` (number, optional): the delta's durable-log journal record number when
  the run used `--log`, absent otherwise. Also declared but never required.
- `summaryLine` (string, optional): present **only** with `--summary-line` or
  `--detail`. Human-readable; wording is not a stable machine contract.
- `details` (array, optional): present **only** with `--detail`. Structured
  explanation of the selected `classes`. Entries are additive; tolerate new
  fields and new detail shapes.
- `enrichment` (object, optional): present only when `--enrich` fetched a body
  for this delta after snapshot publication — see
  [Opt-in emitted-delta enrichment](enrichment.md#opt-in-emitted-delta-enrichment). Never
  written to snapshots or durable logs.
- `watch` (object, optional): present on an emitted delta whose effective
  `(repo, entity, number)` matches a labeled watch entry captured for that tick.
  Shape is `{ "labels": { "<key>": "<value>", ... } }` with keys in ascending
  ASCII order. Omitted entirely when the matching entry has no labels. Identical
  across JSON, compact, NDJSON, log replay, and outpost `delta`. Excluded from
  `delta.id`. Cursor reads replay the recorded map and do not consult today's
  watch directory.
- `staleAt` (string, optional): present only on a `stale` delta — the UTC day
  that triggered it, included in the delta id so distinct periods have
  distinct ids.

Detail entries use `class` to name the class being explained. Common shapes:

- field transition: `{ "class": "closed", "field": "state", "from": "open", "to": "closed" }`;
- numeric transition: `{ "class": "new-comments", "field": "conversationComments", "from": 1, "to": 3, "delta": 2 }`;
- set transition (labels, assignees, requested reviewers): `{ "class": "relabeled", "field": "labels", "added": ["urgent"], "removed": [] }` — same `added`/`removed` shape for `assignees-changed` (`field: "assignees"`) and `review-requests-changed` (`field: "reviewRequests"`);
- presence transition: `{ "class": "missing", "field": "presence", "from": "present", "to": "missing", "missingTicks": 1 }`.

`unresolved-threads-added`/`unresolved-threads-resolved` may also carry a
`field: "threads"` row naming the review-thread ids behind the class,
independent of `unresolvedReviewThreads`'s numeric row:

```json
{
  "class": "unresolved-threads-added",
  "field": "threads",
  "added": ["RT_2"],
  "removed": ["RT_1"]
}
```

This is the only detail row that survives a same-count thread swap (one thread
resolves while another reopens in the same tick): the numeric
`unresolvedReviewThreads` row is skipped in that case because the count itself
did not move, so `added`/`removed` here are what names the swap. It is omitted
entirely when there is no thread-identity swap to name.

`ci-changed` and `review-changed` details name the exact checks/reviews that
changed (added, removed, changed) directly from the always-legible `checks` /
`reviews` fingerprint arrays. The detail keeps its `from`/`to`
values and gains `added`, `removed`, and `changed` arrays:

```json
{
  "class": "ci-changed",
  "field": "checks",
  "added": [{ "name": "lint", "kind": "check", "status": "in_progress", "conclusion": "" }],
  "removed": [],
  "changed": [
    {
      "name": "build",
      "from": { "status": "completed", "conclusion": "failure" },
      "to": { "status": "completed", "conclusion": "success" }
    }
  ]
}
```

`review-changed` follows the same shape on `field: "reviews"` with entries keyed
by `id` (`{ id, author, state, submittedAt, commit }`), and may also include a
readable `reviewDecision` transition. When a detail **cannot** name the change —
one side has no persisted array (the `new`/missing lifecycle), or duplicate
keys make the breakdown unsafe to name (a `CheckRun` and a
`StatusContext` sharing one name) — it falls back to marking the transition
`opaque: true` with no named arrays. Consumers should treat `opaque: true` as
"re-query GitHub if you need specifics" and its absence as "the named breakdown
is authoritative." The public field catalogs are also available without
parsing Markdown through `gh-delta/contract` and `gh-delta --help-json`.

**Ordering:** within a report, PR deltas precede issue deltas; within each family
the order follows the GitHub fetch result. Do not rely on positional access
(`deltas[0]`) or on a stable within-family order across GitHub API changes.
