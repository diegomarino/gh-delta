# Snapshot Semantics

[Documentation](../README.md) · [Contract reference](../contract.md)

For schema-v1 recovery, read the [contract introduction](../contract.md).

The detector is stateless between runs except for the snapshot it owns and
the best-effort [run-registry](registry.md#run-registry) breadcrumb (an index for
`gh-delta list`, never consulted by detection).

**Incremental fetch contract:** open items are always fetched in full (the scope
for missing detection). When a prior snapshot exists, `meta.horizon` (the
timestamp of the previous run) is used as a cutoff, with no overlap by default:
all-states items updated since that cutoff are also fetched to observe closed,
merged, and relabeled transitions. Absent closed items are dormant memory, not a
missing delta — only items the snapshot believes OPEN can vanish.

## Fetch limits (page caps)

Each GraphQL page returns `PAGE_SIZE = 100` items. Per entity family (`pr` or
`issue`), per tick:

- **Open-items phase:** capped at 10 pages (`MAX_OPEN_PAGES`) — **1000 open
  items** per family.
- **Updated-items phase:** capped at 30 pages (`MAX_UPDATED_PAGES`) — **3000
  updated items** per family per tick.

Exceeding either cap — or a nested sub-page overflow (e.g. the CI-check rollup
page inside a PR node) — is treated as incomplete state and **fails closed**
(exit `1`); it never silently truncates and reports partial data. A repository
family with more than 1000 currently-open items, or with more than 3000 items
updated since the last horizon, needs a shorter tick interval or a narrower
`--entities` selection to stay under these caps.

**Rate-limit budget.** GitHub charges GraphQL by _requested_ page shape, not by
rows returned, and `results[].rateLimit` reports the real accumulated cost of
every tick — see [Measured query costs](query-costs.md#measured-query-costs) for the current
numbers and how they were obtained. A typical steady-state tick — both entity
families, one page each, open + updated phases — spends against the GraphQL
budget of **5,000 points/hour per token**; a baseline tick skips the updated
phase and costs half. That leaves headroom for hundreds of ticks per hour, but
the budget is shared by every monitor (and every other GraphQL use) on the
same token. To spend less: drop an entity family with `--entities pr` or
`--entities issue`, lengthen the tick cadence (cost scales linearly), or split
dense fleets across tokens.

Snapshot shape: `{ "pr": object, "issue": object, "meta": object }`. Every item
in `pr`/`issue` is the three-section shape `{fingerprint, context, meta}`:

- `fingerprint`: exactly the compared subset — see
  [Fingerprint fields](fingerprints.md#fingerprint-fields-from--to). No drop-list; every key
  participates in comparison and the delta id.
- `context`: identity/display fields, never compared and never hashed into the
  delta id — see the `context` bullet in [Delta fields](delta-fields.md). Deltas
  carry this same object as their own top-level `context`, so it doubles as
  the delta's contextual metadata.
- `meta` (item-level bookkeeping, not compared): `seenAt`, `changedAt`
  (independent of `head-changed`'s `headSha` tracking — see the `head-changed`
  class), `ticksSinceChange`, `missingTicks`, `staleEmittedFor`.

`meta.schemaVersion` (snapshot-level, alongside `meta.repo`, `meta.monitorId`,
`meta.entities`, and `meta.horizon`, stamped on every successful write) must
equal the current `SNAPSHOT_SCHEMA_VERSION` or the snapshot is unreadable
(`kind: "snapshot"`, hinting at `gh-delta reset`). **There is no migration
path**: a schema-v1 snapshot (missing `meta.schemaVersion`, or an older value)
is not upgraded in place — see the [schema-v1 recovery note](../contract.md).

- The consumer supplies the snapshot **location**, never snapshot **data**.
  gh-delta reads it, diffs, and atomically rewrites it after a successful fetch.
- Attention filters run only after complete detection. Their report/outpost
  suppression never changes the snapshot bytes, which are identical to the
  same observation without filters; a filtered delta is therefore not replayed
  on a later tick.
- The **first run** (no snapshot file) seeds a baseline: exit `0`,
  `results[].baseline: true`, `deltas: []`. Persist the state directory
  between runs (or accept the ephemeral temp default's silent re-baseline).
- Snapshot JSON is strict. A missing file seeds a baseline, but any present
  file that is not the schema-v2 `{ "pr": object, "issue": object, "meta":
object }` shape with numeric object keys and current `meta.schemaVersion` is
  an error (exit `2`) and is not migrated. Write-side validation runs before
  the rename so a bad snapshot is never persisted. The temp file is removed on
  rename failure to avoid leaving stray files.
- A derived `--state-dir` path is scoped by repo, monitor id, **and** selected
  entities. A `--entities pr` run and a `--entities pr,issue` run use **different**
  files; keep `--entities` fixed per monitor so state is not split.
- An eligible economical watch list is intentionally a separate PR-only history:
  its derived path ends `__watch-pr.json` and its explicit-file path appends
  `.watch.json`. Its metadata carries `scope: "watch-pr"`, so `list` reports it
  instead of treating it as an unknown filename. Strict issue-only history ends
  `__watch-issue.json` (explicit `.watch-issue.json`, `scope: "watch-issue"`).
  Strict mixed history that contains an issue ends `__watch-pr-issue.json`
  (explicit `.watch-pr-issue.json`, `scope: "watch-pr-issue"`). A `pr,issue`
  selection with no issue entry keeps using `watch-pr`. None of these paths is
  deleted or rewritten when another scope is created.
- Filename segments are encoded with `encodeURIComponent` **plus `_` additionally
  encoded as `%5F`**, making derived names injective for CLI inputs. Library
  callers passing raw entity strings containing `__` to `snapshotPath` directly
  are outside this guarantee.
- A partial `--entities` run preserves the omitted family's memory in the
  snapshot; it does not erase it.
- **Concurrent ticks against the same state file are locked, not merely
  discouraged.** Writes are atomic (temp file + rename), which prevents
  corruption, but that alone does not prevent a lost update: two overlapping
  runs can both read the old snapshot, both fetch GitHub, and both write —
  the second write clobbers the first run's observations. A state-file lock
  (see [Lock Semantics](locks.md#lock-semantics)) makes a second concurrent run exit
  `1` with `kind: "busy"` instead of silently losing that update. The same
  rule is exposed in `gh-delta --help-json` as `stateConcurrency` so agents
  and schedulers do not need to parse Markdown to discover it.
