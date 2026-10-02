# Watch a small set of items

[Documentation](../README.md) · [Usage by task](../usage.md)

`gh-delta watch add pr:42 --until merged --watch-dir ./state/watch` creates an
atomic local entry; `watch ls` and `watch rm pr:42` never contact GitHub.

```sh
gh-delta watch add pr:3 --until merged --watch-dir ./watch \
  --label thread=t-0004 --label package=F001-P05
gh-delta watch add pr:3 --until merged --watch-dir ./watch --label thread=t-0005
```

The second command replaces the entire label map, preserves `addedAt` and any
`ignoredTerminalAt`, and emits no detector delta. `--label` is invalid on
`watch rm`, `watch ls`, and detector commands. There is no CLI clear flag;
remove and re-add to drop labels from the CLI, which resets lifecycle. API
callers can pass `labels: {}`.

`gh-delta watch sync --from desired.txt --watch-dir ./state/watch` reads a
framed UTF-8 document (`pr:N`/`issue:N`, `until=`, optional `repo=` and labels,
mandatory last record `end N`) and replaces the entire directory with one
`watch-set.json` rename. `--repo` defaults unscoped input lines; it does not
keep omitted repositories. Zero entries require `end 0` and `--allow-empty`.
A truncated file without `end N` exits 2 and leaves membership unchanged.
Redirect stdout away from a detector stream. Check the producer’s exit code
before syncing: a complete frame does not reveal producer failure. After
conversion, leftover `pr-*.json` files are ignored. Old binaries reject
`watch-set.json`; mixed-version `add` can still write sidecars the new reader
ignores. There is no automatic downgrade. `removeWatchUnchanged` and
`markTerminalIgnored` throw in manifest mode; use `readWatch`/`listWatch`.

A tick with an explicit `--watch-dir` automatically uses economical mode when
`--entities` includes `pr` and the validated list has zero to ten PR-only
entries: it makes one aliased GraphQL request for unique PR numbers (or no
GitHub request for an empty list), never fetches issues, and writes an
independent watch snapshot. Its log is derived from that same selected snapshot
path. Derived paths end in `__watch-pr.json`; an explicit `--state-file x.json`
uses `x.json.watch.json`. Removing an entry projects it out before diffing (no
missing delta); a null result for an entry still watched follows the normal
missing lifecycle. Re-adding a removed item can therefore be `new` (or baseline
on a fresh watch snapshot). Without `--watch-strict`, a list containing an
issue, more than ten entries, or `--entities issue` keeps the ordinary full
fetch and ordinary snapshot.

`--watch-strict` keeps that targeted behavior at every list size and extends it
to issues. `--entities pr` rejects applicable issue entries. `--entities issue`
rejects applicable PR entries, fetches `repository.issue(number:)` through the
existing issue normalizer, and writes `__watch-issue.json` (or
`<state-file>.watch-issue.json`). `--entities pr,issue` accepts both. A
selection that still contains only PRs, including an empty list, keeps the
existing `watch-pr` snapshot. The first applicable issue uses a new
`watch-pr-issue` snapshot (`__watch-pr-issue.json`, or
`<state-file>.watch-pr-issue.json`) and does not migrate or delete `watch-pr`.
That first mixed tick is a fresh baseline.

Strict mode captures membership once, orders it by entity (`pr` then `issue`)
then number, and fetches batches of at most ten. A batch may contain both PR
and issue aliases. It publishes a repository only after every batch for that
repository succeeds. A later batch failure or admission refusal still publishes
nothing for that repository, but keeps already validated GraphQL costs in
`results[].rateLimit`. Other repositories in the same invocation keep their
own success or failure. With `--rate-limit-floor`, a batch starts only when
remaining quota minus the floor covers the batches still needed. A finished
last batch may drop below the floor. An empty list makes no GitHub request,
including no quota preflight. `--watch-strict` still requires `--watch-dir`
and remains incompatible with `--number`.

Issue closure, assignment, labels, and comments use the existing issue
classifier. `issue --until closed` retires the entry after that observation; it
does not keep watching a later reopening unless the entry is added again.
Removing an entry projects it out of the strict snapshot instead of emitting a
false missing event.

```sh
gh-delta --repo owner/repo --monitor-id scheduled --entities pr \
  --state-dir ./state --watch-dir ./watch --watch-strict \
  --rate-limit-floor 100 --format ndjson
```

```sh
gh-delta watch add issue:42 --repo owner/repo --until closed \
  --watch-dir ./watch-issues \
  --label project=example --label task=design-voice
gh-delta --repo owner/repo --monitor-id project-issues \
  --state-dir ./state --watch-dir ./watch-issues \
  --watch-strict --entities issue \
  --format ndjson --omit-end --log
```

```sh
gh-delta watch add pr:3 --repo owner/repo --until merged \
  --watch-dir ./watch-mixed --label thread=t-0004
gh-delta watch add issue:42 --repo owner/repo --until closed \
  --watch-dir ./watch-mixed --label task=design-voice
gh-delta --repo owner/repo --monitor-id project-mixed \
  --state-dir ./state --watch-dir ./watch-mixed \
  --watch-strict --entities pr,issue \
  --format ndjson --omit-end --log
```

Use `--number
42,99` for one ephemeral tick instead. Terminal items emit their final delta,
then are removed after snapshot publication.

Common symptoms:

- A monitor re-baselines after reboot: use explicit `--state-dir`.
- `gh` auth fails: run `gh auth status` in the same environment as the monitor.
- Page-cap errors: narrow the monitor scope or re-seed intentionally.
- Snapshot is corrupt: fix or remove the snapshot after confirming the monitor.

See [Troubleshooting / FAQ](../troubleshooting.md) for the full list.
