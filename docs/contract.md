# gh-delta Contract

Canonical, machine-facing contract for `gh-delta`. Other docs link here; do not
duplicate these tables elsewhere (the one exception is the self-contained prompt
in `docs/watch-loop-prompt.md`).

## Exit Codes

- `0`: baseline established or no deltas.
- `10`: deltas found.
- `1`: argument, GitHub CLI, network, or parse error. On errors, the snapshot is
  not updated.

## Delta Classes

- `new`: new issue or PR after the baseline.
- `closed`: issue or PR was closed.
- `reopened`: issue or PR was reopened.
- `merged`: PR was merged.
- `draft-ready`: PR moved from draft to ready for review.
- `ci-changed`: check run or status context changed.
- `review-changed`: review decision or latest review states changed.
- `became-mergeable`: PR moved from conflicting to mergeable.
- `new-comments`: comment count increased.
- `unresolved-threads-added`: unresolved PR review thread count increased.
- `unresolved-threads-resolved`: unresolved PR review thread count decreased.
- `review-threads-changed`: PR review thread total changed while unresolved
  count stayed stable.
- `relabeled`: issue labels changed.
- `missing`: an object from the previous snapshot disappeared from a fetched
  collection. Check pagination, permissions, or scope before trusting the tick.
- `still-missing`: an object that was already missing is still absent from the
  fetch. Treat this as unresolved operational state, not a fresh item.
- `updated`: fingerprint changed without a more specific class. Inspect GitHub
  before dismissing it; review-thread replies can still surface this way in v0.1.

## Report Shape

Field values are illustrative. Each delta's `from`/`to` hold the full entity fingerprint object (shown abbreviated as `{}` here). See [Outpost Payload (schema v1)](#outpost-payload-schema-v1) for when they are `null`.

```json
{
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

## Outpost Payload (schema v1)

One JSON `POST` per delta when the detector exits `10`. `from` and `to` are the
entity fingerprint objects, or `null` when there is no prior/next state (e.g.
`from` is `null` for a `new` object; `to` is `null` for a `missing` object).

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
list, and detector timestamp. PR payloads currently use an empty `labels` array
because the PR fetch does not collect labels.
