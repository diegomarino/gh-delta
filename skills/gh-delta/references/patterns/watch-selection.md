# Pattern 3: monitor a search or selected PR set

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

`gh-delta` does not persist an arbitrary GitHub search. Resolve the search,
then save at most ten selected PRs in the scenario's watch directory:

```bash
gh search prs --repo "$REPO" --state open --checks pending \
  --sort updated --order desc --limit 10 \
  --json number --jq '.[].number' |
while IFS= read -r number; do
  gh-delta watch add "pr:$number" \
    --repo "$REPO" --watch-dir "$WATCH_DIR" --until merged --format text
done

gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --watch-dir "$WATCH_DIR" \
  --entities pr \
  --format compact
```

A one-to-ten PR-only watch list activates one targeted GraphQL request; an
empty list performs no observation query. Without `--watch-strict`, issue
entries, more than ten entries, or `--entities issue` retain broad fetching.
`--watch-strict` watches the explicit list at any size, including issues, in
batches of ten and still makes no request when the list is empty.
`--number` is a post-fetch output selector and does not reduce GitHub work.
Refresh search membership intentionally with `watch sync` (whole-directory
replace, framed `end N`) or with `watch add`/`watch rm`; do not let
an unbounded list accumulate. Use `--until merged` for an integration workflow
or `--until closed` for either a close or a merge. Cleanup uses terminal state
on eligible emitted deltas, including a first observation of an already
terminal item. Attention filters that suppress the terminal transition can
retain the entry; inspect the filters before treating it as stuck. With
`--until merged`, remove an unmerged closed PR during membership refresh if
it no longer belongs in the selection.

## Strict issues and mixed membership

Use this when a coordinator already has the issue numbers and must not scan
the repository. Issue strict mode does not watch a reopening after
`--until closed` retires the entry. A `pr,issue` list that gains its first
issue starts a new `watch-pr-issue` baseline; pass `--entities pr` when stray
issue entries must still be rejected.

```bash
gh-delta watch add issue:42 --repo "$REPO" --until closed \
  --watch-dir "$WATCH_DIR" --label project=example --label task=design-voice
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --watch-dir "$WATCH_DIR" \
  --watch-strict --entities issue \
  --format ndjson --omit-end --log
```

```bash
gh-delta watch add pr:3 --repo "$REPO" --until merged \
  --watch-dir "$WATCH_DIR" --label thread=t-0004
gh-delta watch add issue:42 --repo "$REPO" --until closed \
  --watch-dir "$WATCH_DIR" --label task=design-voice
gh-delta \
  --repo "$REPO" \
  --monitor-id "$MONITOR_ID" \
  --state-dir "$STATE_DIR" \
  --watch-dir "$WATCH_DIR" \
  --watch-strict --entities pr,issue \
  --format ndjson --omit-end --log
```

Limits: at most ten watched items per GraphQL request; an empty list performs
no GitHub request and no quota preflight; `--settled` and other attention
filters are not a queue for events skipped on this tick.
