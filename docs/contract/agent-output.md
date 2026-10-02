# Agent output schemas

[Documentation](../README.md) · [Contract reference](../contract.md)

`gh-delta schema [--format json|compact|ndjson]` is local-only and emits a
draft-2020-12 schema. Published copies live under `schema/`; `npm run
schema:check` detects drift. All three formats share one `$defs.delta`
fragment; the per-format differences are layered on top of the `$ref` at the
usage site, never by forking the fragment (see
[Report Shape](report.md#report-shape)): `json` additionally requires `from`/`to` on
every delta, `compact` requires neither, and `ndjson` requires its own `type`
discriminator. Compact/NDJSON never include `from`/`to` unless `--full` is set,
and never include `summaryLine` or `details` unless `--summary-line`/`--detail`
is set; each delta always includes `context`, `summary`, and a bounded pure
`changed` fingerprint diff.

**Compact envelope:** `schemaVersion`, `repos` (included whenever the
underlying report carries one — i.e. always for the enveloped detector
report; omitted for the bare pre-flight error shape), `detectedAt` (the
enveloped report's own `detectedAt`, or the bare pre-flight error shape's
`at` — the compact/ndjson field is always named `detectedAt` regardless of
source), `baseline` (included only when exactly one repo ran that tick, taken
from that repo's `results[0].baseline`; omitted on a multi-repo run, since
compact/ndjson carries no `results[]` to hold a per-repo baseline flag),
`counts` (`{deltas, byClass, filteredDeltas}` — `byClass` keys are present
only for classes with at least one matching delta this tick), `deltas`, an
optional `errors` array (`{repo?, kind, message, hint?, resetAt?}`, one row
per `results[]` entry with an error, or the single bare pre-flight error;
omitted when there are none), and `warnings` (always present, possibly
empty). **NDJSON** renders one `{type: "delta", ...}` record per delta
(the same fields `compactDelta` produces), followed by exactly one
`{type: "end", schemaVersion, detectedAt, repos?, baseline?, counts, errors?,
warnings, exitCode}` record.

- `--summary-line` adds a human-readable `summaryLine` to each delta in JSON
  output. This is for logs and agent messages; do not parse it.
- `--detail` adds structured `details` to each delta and also adds
  `summaryLine`. Prefer `summaryLine` for the human line and `details` /
  `classes` for decisions.
- `--summaries` is a **deprecated no-op**: `delta.summary` is always present now
  (see [Delta Summary schema](summary.md#delta-summary-schema)) regardless of this flag.
  It is kept accepted so existing scripts passing it are unaffected; it changes
  nothing.
- `--full` includes the full `from`/`to` fingerprints in compact/ndjson output.
  They are always present in `--format json`; omitted in compact/ndjson unless
  this flag is set.
- `--only-classes <classes>` is an attention filter: keep a delta when it
  carries at least one comma-separated class name. `classes` must contain one
  or more values from `DELTA_CLASSES`; whitespace and duplicate names are
  ignored, and an unknown name is a configuration error (exit `2`).
- `--ignore-classes <classes>` is an attention filter: remove the named
  comma-separated `DELTA_CLASSES` values from every delta, then drop a delta
  left with no classes. It has the same validation, whitespace, and duplicate
  behavior as `--only-classes`.
- `--ignore-authors <logins>` is a comma-separated, case-insensitive list of
  non-empty GitHub logins. It is a post-detection attention filter covering
  three surfaces: it removes `new-comments` only when the positive
  `conversationComments` increment fits the observed final comment rows and
  every inferred row has an id and a listed author; it removes `review-changed`
  the same way against `reviews`; and it removes `review-comments-added` the
  same way against the affected review threads' reply increments. It fails
  open on overflow, missing id/author, aggregate/observed-count mismatch, or
  other uncertainty. Snapshots still advance; `filteredDeltas` is present
  whenever this flag is supplied.

  **The one pre-publish quota exception:** when `--ignore-authors` and
  `--enrich thread-replies` are both set, `thread-replies` is additionally
  fetched once, scoped to filtering only, **before** the snapshot/log write —
  the single documented case where opt-in enrichment quota is spent before
  publication (every other `--enrich` fetch runs after). It never populates
  `delta.enrichment` before publication; that still only happens through the
  ordinary post-publish enrichment pass. Without the double opt-in
  (`--ignore-authors` alone, without `--enrich thread-replies`), a
  `review-comments-added` delta whose reply authors cannot be verified fails
  open with an explicit warning instead of guessing.

- `--settled` is an attention filter that drops a delta whose normalized summary
  has `ciRollup: "pending"` or `mergeable: "unknown"`. It implies `summary` is
  read (which is now unconditional); no explicit `--summaries` flag is needed.
  `ciRollup: "none"` is settled and is kept.

**Attention filters are not a queue: detection and the snapshot still advance
for filtered changes, and filtered changes are not replayed later.** When flags
are combined, their order is binding: `--only-classes`, then
`--ignore-classes`, then `--ignore-authors`, then empty-delta removal, then `--settled`.
`filteredDeltas` counts only deltas removed entirely; removing one class from a
surviving multi-class delta does not increment it.

- `--baseline-emit-state` is optional and off by default. On the run that seeds a
  baseline, it emits one synthetic `baseline-state` delta per tracked OPEN item
  (`from: null`, `to`: the observed item) so state that already existed at
  baseline is visible instead of silent until the item next changes. The run then
  exits `10` with `baseline: true` and a non-empty `deltas` array; ids are stable
  across re-baselining. Without the flag, baseline behavior is byte-identical. See
  the [`baseline-state`](delta-classes.md#delta-classes) class and [Exit Codes](exit-codes.md#exit-codes).
- `--log` is optional and off by default. It appends each surviving post-filter,
  post-decoration delta to a monitor-bound NDJSON journal, fsyncs it, then
  atomically publishes its reader-visible boundary before snapshot publication.
  Its path is `<stateDir>/log-<encoded repo>__monitor-<encoded
monitorId>__<entities>.ndjson`, or `<state-file>.deltalog.ndjson` for an explicit
  state file. The success report adds absolute `results[].logFile`, including
  on zero-delta ticks; zero-delta ticks do not open the log. Without `--log`
  that field is omitted and the log module is never opened.
- `--enrich review,comments,threads,body,thread-replies` is a comma-separated,
  deduplicated selection of body fetches, off by default. After a successful
  snapshot write only, it fetches bodies for matching emitted deltas:
  `review-changed` (`review`), `new-comments` (`comments`),
  `unresolved-threads-added` (`threads`), `new`/`first-seen`/`reopened`/
  `baseline-state` (`body` — one `nodes()` call per delta for the item's own
  body, attached as `enrichment.body = { body, mentions }`; never called for a
  plain `updated`), or `review-comments-added` (`thread-replies` — one aliased
  per-thread GraphQL call per delta, each thread's own `comments(last: N)`
  where `N` is that thread's reply-count increment). Failures are warnings and
  never change detection state. See the `--ignore-authors` bullet above for the
  one pre-publish exception.
- `--outpost-url` is optional at-most-once HTTP delivery; see
  [Outpost Payload](outpost.md#outpost-payload-schema-v2). It does not affect the JSON
  report, exit code, or snapshot.
- `--outpost-secret` names (never contains) an environment variable holding the
  shared HMAC secret. It requires `--outpost-url`; invalid names and unset or
  empty values are configuration errors before repository derivation or I/O.
- `--outpost-timeout-ms` timeout in milliseconds for each outpost HTTP POST
  (default `4000`).
- `--outpost-max-posts` maximum number of outpost POSTs per run (default:
  unlimited). Excess deltas are skipped with an outpost warning.
- `--gh-timeout-ms` timeout in milliseconds for each `gh` subprocess call
  (default `60000`).
- `--rate-limit-floor <n>` is an opt-in pre-fetch GraphQL quota floor. `n` is a
  non-negative safe integer. After acquiring the state lock and validating the
  current snapshot, the detector reads `resources.graphql.remaining` from one
  `gh api rate_limit` call immediately before the observation fetch. Equality
  proceeds. A lower remaining quota exits `1` with `kind: "rate-limit"`, a
  stable message naming both values, and top-level ISO-8601 UTC `resetAt`; it
  leaves the snapshot, log, outpost, and watch cleanup untouched. A malformed
  or failed rate-limit request remains the ordinary transient `github` error.
  Omitted means no rate-limit call and byte-identical legacy behavior.
  `--watch-strict` uses a different admission line: `remaining - floor >= batchesStillNeeded`.
  See [Watch-directory selection](watch-selection.md#watch-directory-selection).
- `--no-registry` skips the best-effort [run-registry](registry.md#run-registry) breadcrumb
  this run would otherwise leave for `gh-delta list`. Equivalent to setting
  `GH_DELTA_NO_REGISTRY=1`. It never affects the report, exit code, or snapshot.
- `--lock-stale-ms` is optional (default `10m`; grammar shared with `--since`,
  see [`parseDuration`](programmatic-api.md#programmatic-api-surface)). It is a ceiling on how old
  an **unreadable/corrupt** state-file lock must be before it is presumed
  abandoned and stolen (with a warning). It does **not** apply to a readable
  lock — that one is only ever stolen once its own `expiresAt` has passed. See
  [Lock Semantics](locks.md#lock-semantics).

**Repeated flags:** the last value wins. This applies to both class-list flags;
duplicate class names within one comma-separated list are ignored. **`--help`, `--help-json`, and
`--version` take precedence over all validation** — an agent probing with
`--help-json` receives the help document even when the rest of the command line
is invalid.
