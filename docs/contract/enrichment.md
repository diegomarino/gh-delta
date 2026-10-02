# Opt-in emitted-delta enrichment

[Documentation](../README.md) · [Contract reference](../contract.md)

`--enrich review,comments,threads,body,thread-replies` is a comma-separated,
deduplicated selection of body fetches. It is off by default. Only final
emitted deltas can trigger it: new/changed `changes_requested` reviews on
`review-changed`, identifiable new conversation comments on `new-comments`,
newly unresolved thread ids on `unresolved-threads-added`, the item's own body
on `new`/`first-seen`/`reopened`/`baseline-state` (`body`), and new inline
review replies on `review-comments-added` (`thread-replies`). Each selected
`(delta, kind)` makes at most one GraphQL call after the snapshot write.
Missing durable identities or a GitHub/shape failure produces a warning and no
speculative fetch. See the `--ignore-authors` bullet in
[Agent output schemas](agent-output.md#agent-output-schemas) for the one case where
`thread-replies` is fetched pre-publish instead.

Successful non-empty kinds attach this optional sibling:

```json
{ "enrichment": { "review": [], "comments": [], "threads": [], "body": null } }
```

Review rows contain `id`, `author`, `state`, `submittedAt`, `commit`, and `body`;
comment rows contain `id`, `author`, `createdAt`, `body`, and deterministic
case-insensitive-deduplicated `mentions`; thread rows contain `id` and a
`firstComment` with id, author, createdAt, path, line, originalLine, and body
(`line`/`originalLine` here are GitHub's own review-comment line numbers, not
the retired v1 `delta.line` alias); `body` is `{ body, mentions }` for the
item's own body. Nullable GitHub values remain `null`. Enrichment never changes
ids, classes, exit codes, snapshots, or durable delta logs; `gh-delta read`
does not replay it. Outpost payloads mirror it when present.
