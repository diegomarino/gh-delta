# Enrichment

[Documentation](../README.md) · [Usage by task](../usage.md)

`--full` includes the full `from`/`to` fingerprints in `compact`/`ndjson`
output (always present in `--format json`; omitted otherwise). Use it when a
consumer of the bounded agent formats needs the raw compared state instead of
just `delta.changed`.

`--enrich <kinds>` is an opt-in, comma-separated selection of body fetches
(`review`, `comments`, `threads`, `body`, `thread-replies`), off by default.
After a successful snapshot write, it fetches bodies only for matching
emitted deltas — one extra GitHub call per matching `(delta, kind)` pair, so a
delta whose classes match multiple selected kinds costs one call per matching
kind, never one per observed item — and attaches the result as transient
`delta.enrichment`
(never written to the snapshot or a durable log, and never affecting
detection):

- `review`: `review-changed` deltas — the review body text.
- `comments`: `new-comments` deltas — the new top-level comments.
- `threads`: `unresolved-threads-added` deltas — the newly unresolved
  thread's body.
- `body`: `new`/`first-seen`/`reopened`/`baseline-state` deltas — the item's
  own body, as `enrichment.body = { body, mentions }` (never fetched for a
  plain `updated`).
- `thread-replies`: `review-comments-added` deltas — each affected thread's
  new inline replies.

A failed enrichment fetch is a warning, never a detection-state change.

**The one pre-publish quota exception:** ordinarily every `--enrich` fetch
runs after the snapshot/log write. The one exception is when
`--ignore-authors` and `--enrich thread-replies` are **both** set: gh-delta
additionally runs one filter-scoped `thread-replies` fetch **before**
publication, solely to verify reply authorship for the `--ignore-authors`
filter — it does not populate `delta.enrichment` early. Setting
`--ignore-authors` alone (without `--enrich thread-replies`) does not spend
this pre-publish call; a `review-comments-added` delta whose reply authors
cannot otherwise be verified instead fails open with an explicit warning.
