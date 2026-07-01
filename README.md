# gh-delta

`gh-delta` is a small deterministic GitHub watcher for agent or automation loops.
It compares the current GitHub issue and pull request state with a local snapshot,
prints a JSON report, and exits with a code that tells the caller whether anything
changed.

The tool does not decide what to do. It only detects changes such as new PRs,
merged PRs, CI status changes, review decision changes, new comments, relabeling,
missing objects, and catch-all updates. Your orchestrator, script, or agent owns
the action.

## Requirements

- Node.js 18 or newer.
- GitHub CLI (`gh`) installed and authenticated.
- Read access to the repository being watched.

## Quick Start

Install from npm once published:

```bash
npm install --global gh-delta
gh-delta --help
gh-delta-tick --help
```

Or run from a source checkout:

```bash
git clone https://github.com/<owner>/gh-delta.git
cd gh-delta
npm install
npm run check

node ./gh-delta.mjs \
  --repo owner/repo \
  --branch watch \
  --detail \
  --state-file ./state/owner-repo-watch.json
```

The first successful run establishes the baseline and exits `0`. Later runs compare
against that baseline.

For scheduled watcher ticks, prefer the operator-friendly wrapper:

```bash
node ./gh-delta-tick.mjs \
  --repo owner/repo \
  --branch watch \
  --state-file ./state/owner-repo-watch.json
```

To notify an external endpoint when deltas appear, add an HTTP(S) outpost:

```bash
node ./gh-delta-tick.mjs \
  --repo owner/repo \
  --branch watch \
  --state-file ./state/owner-repo-watch.json \
  --outpost-url https://example.com/gh-delta
```

## CLI

```bash
gh-delta --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--detail] [--outpost-url <url>]
gh-delta-tick --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--outpost-url <url>]
```

Options:

- `--repo`: repository in `owner/name` form. Required.
- `--state-file`: local snapshot JSON path. Required.
- `--branch`: branch, worktree, or watch-loop name to include in reports.
- `--entities`: `pr`, `issue`, or `pr,issue`. Defaults to `pr,issue`. When a
  partial entity set is used, the unrequested side of the snapshot is preserved.
- `--detail`: add a human-readable `line` field to each delta.
- `--outpost-url`: HTTP(S) endpoint that receives one JSON `POST` per delta when
  the detector exits `10`.
- `--help`: print usage.

`gh-delta` prints the structured JSON detector report. `gh-delta-tick` runs the
same detector once, then prints a heartbeat and suggested next actions for an
agent or operator. Neither command creates schedules, timers, automations, or
wake-ups.

Exit codes:

- `0`: baseline established or no deltas.
- `10`: deltas found.
- `1`: argument, GitHub CLI, network, or parse error. On errors, the snapshot is not
  updated.

## Outpost Delivery

`--outpost-url` is optional. Without it, behavior is unchanged. With it,
`gh-delta` and `gh-delta-tick` validate the URL before fetching GitHub state, then
send one HTTP `POST` per delta only when the detector exits `10`.

Outpost delivery is fire-and-forget and at-most-once:

- no retries;
- no batching;
- no outbox, JSONL queue, SQLite store, or acknowledgement layer;
- outpost failure, timeout, DNS failure, `4xx`, or `5xx` does not change the
  detector or tick exit code;
- the snapshot has already advanced before outpost delivery is attempted.

The external endpoint is responsible for filtering events, deduplicating by
`eventId`, and executing any downstream action. Outpost logs intentionally avoid
printing endpoint URLs, query strings, headers, or future auth material.

Payload schema v1:

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:watch:issue:17:relabeled:2026-07-01T12:00:00.000Z",
  "repo": "owner/repo",
  "branch": "watch",
  "detectedAt": "2026-07-01T12:00:00.000Z",
  "entity": "issue",
  "number": 17,
  "title": "Backfill imports",
  "classes": ["new", "relabeled"],
  "state": "OPEN",
  "labels": ["worker", "backend"],
  "line": "ISSUE #17 \"Backfill imports\": new, relabeled",
  "delta": {
    "from": null,
    "to": {}
  },
  "links": {
    "html": "https://github.com/owner/repo/issues/17"
  }
}
```

`eventId` is deterministic for a given repo, branch, entity, number, class list,
and detector timestamp. PR payloads currently use an empty `labels` array because
the PR fetch does not collect labels.

## Report Shape

```json
{
  "baseline": false,
  "repo": "owner/repo",
  "branch": "watch",
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
- `relabeled`: issue labels changed.
- `missing`: an object from the previous snapshot disappeared from a fetched
  collection. Check pagination, permissions, or scope before trusting the tick.
- `still-missing`: an object that was already missing is still absent from the
  fetch. Treat this as unresolved operational state, not a fresh item.
- `updated`: fingerprint changed without a more specific class. Inspect GitHub
  before dismissing it; review-thread replies can still surface this way in v0.1.

## Watch Loop Use

See [RUNBOOK.md](RUNBOOK.md) for timer-driven loop patterns. `gh-delta` does not
schedule itself. The recommended setup is cron-native: seed the baseline once,
then create a recurring scheduler whose prompt runs one detector tick and stops.
Do not call `ScheduleWakeup` or create another cron from inside a cron-owned
tick.

See [docs/watch-loop-prompt.md](docs/watch-loop-prompt.md) for a prompt template
for cron-owned watcher ticks.

Delivery note: successful detections advance the snapshot before any agent action
or outpost finishes. Keep scheduler logs for tick output, or add an external
queue if you need at-least-once action delivery.

## Design Notes

`gh-delta` is split into pure logic and impure edges:

- `lib/args.mjs`: shared CLI argument helpers for entity selection and outposts.
- `lib/fingerprint.mjs`: stable fingerprints for PRs and issues.
- `lib/detect.mjs`: compares snapshots and classifies deltas.
- `lib/gh.mjs`: calls `gh pr list` and `gh issue list`.
- `lib/snapshot.mjs`: reads and atomically writes snapshot files.
- `lib/outpost.mjs`: validates outpost URLs, builds schema v1 payloads, and sends
  short-timeout HTTP POSTs.
- `gh-delta.mjs`: CLI wiring and exit codes.
- `gh-delta-tick.mjs`: one-tick wrapper with heartbeat text and suggested actions.

More detail is in [docs/architecture.md](docs/architecture.md).

Current v0.1 scope: the GitHub CLI fetch fails closed if either PR or issue
results hit the hard `500` item limit. Use a narrower watch scope or wait for a
paginated fetcher for larger repositories.

## Development

```bash
npm test
npm run test:coverage
npm run lint
npm run format:check
npm run check
npm run release:check
```

`npm run check` is the normal local gate: ESLint, Prettier check, then the Node
test suite. `npm run release:check` adds the coverage report and `npm pack
--dry-run` package-content verification.

The project intentionally has no runtime dependencies. Development tooling is
limited to ESLint and Prettier.

See [docs/release-checklist.md](docs/release-checklist.md) before publishing a
new npm release.
