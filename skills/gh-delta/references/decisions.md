# Decision boundaries and best practices

<!-- toc -->

**Contents**

- [Identity and ownership](#identity-and-ownership)
- [Scope and cost](#scope-and-cost)
- [Baselines and failures](#baselines-and-failures)
- [Logs and acknowledgement](#logs-and-acknowledgement)
- [Safety boundary](#safety-boundary)
- [Per-delta templates](#per-delta-templates)

<!-- /toc -->

## Identity and ownership

- One recurring producer owns one snapshot identity: repository,
  `--monitor-id`, entity selection, and state path. Keep all four stable.
- Name a session-owned identity
  `<agent-type>-<last8(session-id)>-<purpose>`. Resuming the same conversation
  keeps its identity; a new session gets a new scenario instead of silently
  adopting another session's snapshot.
- An intentionally cross-session producer has no session owner. Give it an
  explicit stable role such as `coordinator-<purpose>` and manage it through
  its scheduler.
- Store automation state in an explicit durable `--state-dir`; the default is
  temporary and can silently re-baseline after cleanup or reboot.
- Do not overlap ticks for the same identity. A busy lock is a reason to wait,
  not to create a second monitor or delete the lock blindly.
- A scheduler owns recurring timing. `gh-delta` intentionally performs one
  observation and exits; `wait` is the bounded exception for one worker
  condition.

## Scope and cost

- Ask whether the user wants PRs, issues, both, or a selected set before the
  first baseline. Changing entities later changes monitor identity.
- Prefer the smallest universe that answers the question. A PR-only watch list
  containing at most ten entries uses a targeted GraphQL query. `--watch-strict`
  is the same targeted fetch for any count of PRs, for issue-only lists, and
  for mixed lists. It never scans the repository issue or PR connection.
  Issue-only and mixed-with-issues histories are separate snapshots
  (`watch-issue`, `watch-pr-issue`) and start a fresh baseline. A `pr,issue`
  selection that still contains only PRs keeps the existing `watch-pr` history.
- `--number` filters results after the ordinary fetch. It does not make a large
  repository cheaper or avoid broad-query failures.
- Broad fetching fails closed above 1,000 open items per entity family or 3,000
  items updated since the horizon. It never publishes a partial snapshot.
- Use `--rate-limit-floor` when several monitors share one GitHub token and
  exhausting the shared GraphQL budget would be worse than a delayed tick.
- Measure actual query cost from JSON `results[].rateLimit`, which accumulates
  the repository's GraphQL calls. It can be null when no query was made. On an
  incomplete `--watch-strict` observation it still reports already validated
  batch costs; it does not invent a cost for a failed or refused request.

## Baselines and failures

- A missing snapshot creates a baseline; it is not evidence that every
  pre-existing item was just created.
- Exit `1` is retryable and leaves the failed repository's previous snapshot
  unchanged. Preserve the state and retry on the next scheduled slot; inspect
  `results[].error` because other repositories may already have succeeded.
- Exit `2` is permanent for that invocation. Diagnose configuration or snapshot
  bytes before retrying; make a recovery copy before any intentional reseed.
- For pre-0.7 snapshots or logs, follow the
  [upgrade recovery procedure](troubleshooting.md#upgrade-from-pre-07-state).
- `status` is local-only unless `--refresh` is explicit. `doctor`, `list`,
  `read`, `explain`, and watch-list management have documented read/local
  boundaries—use them before adding another GitHub fetch.

## Logs and acknowledgement

- One coordinator fetches GitHub with `--log`; workers read the published log
  without owning or copying the snapshot.
- Obtain the actual `logFile` from the producer report's `results[0].logFile`
  (there is no top-level `logFile`). Never reconstruct its encoded filename.
- Give one cursor per consumer and one active process per cursor.
- Read without `--advance`, durably complete or enqueue the work, then set the
  cursor to the report's `cursor.to`. `read --advance` is appropriate only when
  advancing before downstream handling is acceptable.
- Repeated `--template` flags follow the same last-value rule as `--format`.
- Use stable `delta.id` for idempotency. A sequence number is a journal
  position, not a cross-system exactly-once key.
- Upgrade monitors that share a deduplication consumer together: delta IDs are
  stable within a gh-delta version, but fingerprint changes across releases
  can change them. Outpost v2 sends the report delta under `delta`; use
  `deliveryId` for send-attempt identity and `delta.id` for change identity.

Opted-in NDJSON (`--omit-end` with `--format ndjson`) may omit the `end` record.
Completeness, counts, and exit metadata then live in the process status and in
prefixed stderr diagnostics, not in the stream.

## Safety boundary

A green CI rollup, approval, mergeability change, or resolved thread is an
observation—not authorization. Inspect current GitHub state and follow the
user's mutation policy before commenting, closing, assigning, or merging.

## Per-delta templates

- `--format template` prints one escaped line per emitted delta. It is not
  NDJSON and does not emit `end`.
- `{watch.labels.task.id}` is one label key (`task.id`), not nested objects.
- `--template-sha256` covers raw file bytes, including a trailing newline the
  compiler later strips.
- Escaping does not make interpolated title or body text safe to execute.
- `read` does not inherit detector `template` / `template-file` config.
- The path allowlist is the contract section, not an open JSON walk.
