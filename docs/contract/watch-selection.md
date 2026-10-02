# Watch-directory selection

[Documentation](../README.md) · [Contract reference](../contract.md)

`--watch-dir <path>` and `--number <positive,...>` are mutually exclusive
post-fetch selectors. Watch entries are canonical `{entity,number,until,addedAt}`
JSON files, plus optional `repo` (scoped entry), `ignoredTerminalAt` (ISO timestamp -- see below),
and `labels` (a sorted string map, omitted when empty). Old binaries reject files
that contain `labels`. Unlabeled files stay byte-compatible. Malformed entries are
permanent configuration errors before a GitHub call or snapshot write.
`watch add|rm|ls|sync` are local-only commands; terminal watched items are removed
only after their final delta and successful snapshot write, guarded against
concurrent replacement.

The first successful `watch sync` publishes `watch-set.json`
(`{formatVersion:1,generation,entries}`) by same-directory rename. After that
file exists it is the only authority: leftover per-entry JSON is neither merged
nor deleted as part of success, and a malformed manifest does not fall back.
`--repo` on sync is an input default, not a partial update. `generation` is
internal; it changes on every real mutation. A detector that captured a
generation aborts with exit 1 (busy) if it changed before log or snapshot
publication. Directory-lock busy is exit 1; malformed watch state remains
exit 2.

In manifest mode, `addWatch`/`removeWatch`/`listWatch` still return
`path` as `join(dir, watchFilename(entry))`; that path is not a readable file.
`removeWatchUnchanged` and `markTerminalIgnored` throw an unsupported-operation
error and do not modify the manifest. The directory lock uses a fixed internal
lease independent of `--gh-timeout-ms` and `--lock-stale-ms`. It does not make
a network filesystem or an expired lease safe; the same residual check-to-rename
gap documented in [Lock Semantics](locks.md#lock-semantics) remains.

`ignoredTerminalAt` is written the moment a watched item's terminal
transition (a merge or close matching its `until`) is observed but
suppressed by `--ignore-classes`/`--only-classes`: without it, a LATER,
unrelated delta on the same (now-terminal) item -- which carries no
transition class of its own, since a state does not transition twice --
would silently clean up the entry despite the filter's intent. Once
recorded, the entry stays protected for as long as, and only as long as,
the CURRENT invocation's filters still target that terminal class; dropping
the filter lets the very next delta clean it up. An entry written before
this field existed simply lacks it, which means exactly "no terminal
transition has ever been ignored for this entry" -- not an invalid or
stale shape to migrate or reject.

With an explicit `--watch-dir`, a validated list with zero to ten entries, only
`pr` entities, and an `--entities` selection that includes `pr` automatically
becomes an economical PR universe. It makes
exactly one GraphQL request using `repository.pullRequest(number:)` aliases for
the unique watched numbers (zero requests for an empty list), normalizes the
same complete PR shape as broad polling, and never fetches issues. GraphQL
errors, malformed aliases, and any nested connection overflow fail closed.
Without `--watch-strict`, `--number`, `--entities issue`, any issue entry, or
more than ten entries retains broad fetching and the ordinary snapshot.

`--watch-strict` requires `--watch-dir` and rejects `--number` and
`wait --from-log`. It observes exactly the applicable watched entities:

- `--entities pr` rejects an applicable issue entry with
  `--watch-strict cannot include issue watch entries` and keeps the `watch-pr`
  universe at every list size.
- `--entities issue` rejects an applicable PR entry with
  `--watch-strict cannot include pr watch entries`. Issues are fetched with
  `repository.issue(number:)` and normalized by the same issue path as broad
  polling, including closure, assignment, label, and comment classes. This is
  a new `watch-issue` baseline. Before this release, `--entities issue` was a
  configuration error (`--watch-strict requires an entity selection including pr`);
  that error is gone.
- `--entities pr,issue`, including the default selection, accepts both. If no
  applicable entry is an issue, including an empty list, the tick stays on the
  historical `watch-pr` snapshot. Previously an applicable issue entry was
  rejected even under this selection. It now starts a separate `watch-pr-issue`
  baseline. The previous `watch-pr` file is not deleted, migrated, or reset.

Callers that want the old rejection of stray issue entries must pass
`--entities pr`. A mismatch, duplicate effective identity, or invalid watch
entry fails before network work or state mutation (exit 2).

Strict mode captures membership once per repository and orders it by entity
(`pr`, then `issue`) and number. Identity is `(repo, entity, number)`, so equal
numbers do not collide across entities or repositories. It fetches sequential
batches of at most ten items. A batch that contains an issue uses PR and issue
aliases in that one request; a `watch-pr` batch keeps the existing targeted PR
query. It does not read `pullRequests` or `issues` connections. A null alias is
the ordinary missing item. A missing alias, wrong `__typename`, wrong number,
GraphQL error, or nested connection overflow fails the batch and is not a
successful observation. It publishes a repository only after every required
batch for that repository succeeds. A later issue batch cannot publish an
earlier PR batch from the same repository. Other repositories keep the existing
per-repository success and failure split; there is no global atomicity across
repositories.

Batch count `B = ceil(N / 10)` is a minimum cost, not an estimate or a cap:
GitHub charges at least one point per request and cost prediction is approximate
([rate limits and query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
With `--rate-limit-floor F` and `B > 0`, one REST preflight runs after the
state lock. A batch is admitted only when `remaining - floor >= batchesStillNeeded`.
Refusal is `kind: "rate-limit"`, exit 1, and names remaining, floor, batches
still needed, and `resetAt`. A later batch failure or admission refusal still
publishes nothing for that repository, but `results[].rateLimit` retains already
validated costs and the last remaining/reset values. A completed final batch
may finish below the floor and still publishes, because no further batch needs
admission. An empty strict list makes no GitHub call, including no REST
preflight, for every strict entity selection. Without the floor, strict mode
performs no REST preflight. Non-strict floor behavior stays the single
`remaining < floor` comparison.

Strict ticks use a separate identity from poll snapshots. `watch-pr` derived
paths end in `__watch-pr.json`, and `--state-file x.json` becomes
`x.json.watch.json`. `watch-issue` uses `__watch-issue.json` and
`x.json.watch-issue.json`. `watch-pr-issue` uses `__watch-pr-issue.json` and
`x.json.watch-pr-issue.json`. Locks, logs (the selected state file plus
`.deltalog.ndjson`), registry entries, reports, and writes use that selected
path, so a new scope never reads or overwrites another observation universe.
Creating `watch-issue` or `watch-pr-issue` does not delete or reset existing
state. The first successful tick of a new scope is a quiet baseline.
Before diffing, the old strict snapshot is projected to current watch
membership: removing an entry is silent and prunes that entity's number on the
next write; a null alias for an entry that remains watched enters the regular
missing lifecycle. Re-adding a previously projected item may consequently be
`new`. `issue --until closed` retires the entry after the closing observation
and does not keep watching a later reopening. Attention filters such as
`--settled` are not a delay queue: a filtered delta is not replayed for that
consumer, and the snapshot can still advance.
