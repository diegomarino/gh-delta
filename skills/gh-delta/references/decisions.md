# Decision boundaries and best practices

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
  containing at most ten entries uses a targeted GraphQL query.
- `--number` filters results after the ordinary fetch. It does not make a large
  repository cheaper or avoid broad-query failures.
- Broad fetching fails closed above 1,000 open items per entity family or 3,000
  items updated since the horizon. It never publishes a partial snapshot.
- Use `--rate-limit-floor` when several monitors share one GitHub token and
  exhausting the shared GraphQL budget would be worse than a delayed tick.

## Baselines and failures

- A missing snapshot creates a baseline; it is not evidence that every
  pre-existing item was just created.
- Exit `1` is retryable and leaves the previous snapshot unchanged. Preserve
  the state and retry on the next scheduled slot.
- Exit `2` is permanent for that invocation. Diagnose configuration or snapshot
  bytes before retrying; make a recovery copy before any intentional reseed.
- `status` is local-only unless `--refresh` is explicit. `doctor`, `list`,
  `read`, `explain`, and watch-list management have documented read/local
  boundaries—use them before adding another GitHub fetch.

## Logs and acknowledgement

- One coordinator fetches GitHub with `--log`; workers read the published log
  without owning or copying the snapshot.
- Obtain the actual `logFile` from the producer report. Never reconstruct its
  encoded filename.
- Give one cursor per consumer and one active process per cursor.
- Read without `--advance`, durably complete or enqueue the work, then set the
  cursor to the report's `cursor.to`. `read --advance` is appropriate only when
  advancing before downstream handling is acceptable.
- Use stable `delta.id` for idempotency. A sequence number is a journal
  position, not a cross-system exactly-once key.

## Safety boundary

A green CI rollup, approval, mergeability change, or resolved thread is an
observation—not authorization. Inspect current GitHub state and follow the
user's mutation policy before commenting, closing, assigning, or merging.
