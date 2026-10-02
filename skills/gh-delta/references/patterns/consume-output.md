# Consume schema v2 output

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

Check the exit code and `schemaVersion === 2` before interpreting a report.
For ordinary JSON detector output, one repository and many repositories use
the same `repos`/`results[]` envelope. Read `baseline`, `stateFile`, `logFile`,
`rateLimit`, and any per-repository `error` from the matching `results[]` row.
Use `results[0]` only for a known single-repository invocation. `deltas` is
the flattened collection; route multi-repository deltas using their `repo`.
Inspect all result rows on a partial failure: successful repositories may
already have published their snapshots and logs.

A failure before repository execution can instead return a bare error with
`kind`, `error`, `hint`, and `at`, without `results`. Subcommands such as
`read`, `status`, and `reset` retain their own command-specific envelopes.

Use `delta.context` for title, URL, author, and PR branch name. Use `classes`
for change categories, `changed` for the bounded field diff, and `summary`
for current semantic state. Issue summaries contain `{state}`; a missing
item has `summary: null`. Fingerprints use lowercase enums and readable
arrays. `from` and `to` are bare fingerprints, while persisted snapshot
items have separate `fingerprint`, `context`, and `meta` sections.

Compact output has `counts`, `deltas`, optional `errors`, and `warnings`;
it does not carry `results[]`. NDJSON ends with one `type: "end"` record
containing counts, errors when present, warnings, and `exitCode`; inspect
that record even when earlier delta records were received. Use JSON when
the consumer needs per-repository state paths or quota measurements.

For exact field definitions, consult the canonical
[contract](https://github.com/diegomarino/gh-delta/blob/main/docs/contract.md)
or the local `gh-delta schema --format json|compact|ndjson` command, choosing
one format. Tolerate additive fields within schema v2.

## Output choice

- `compact`: bounded self-contained agent input.
- `ndjson`: streaming one-record-per-delta consumers.
- `json`: complete integration contract and structured detail.
- `text`: operator logs, not machine parsing.
- `--detail`: exact changed fields when the consumer must explain a delta.
- `--full`: include `from`/`to` in compact or NDJSON when the bounded `changed`
  diff is insufficient. JSON includes them by default.
- `delta.summary`: current semantic state, derived without a second GitHub
  fetch (`--summaries` is a deprecated no-op).
- `--enrich review,comments,threads`: fetch bodies for matching emitted review,
  conversation-comment, and unresolved-thread deltas after snapshot publication.
- `--enrich body,thread-replies`: fetch item bodies for
  `new`/`first-seen`/`reopened`/`baseline-state`, or reply bodies for
  `review-comments-added`. Read `flags.md` for bounds and matching rules;
  enrichment can add GitHub calls and warnings without undoing the snapshot.
  With `--ignore-authors`, thread replies are also fetched before publication
  for filtering; that pass does not populate the emitted enrichment.
