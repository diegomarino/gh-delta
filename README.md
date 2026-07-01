# gh-delta

`gh-delta` is a small deterministic GitHub watcher for agent or automation loops.
It runs one detection pass, compares current GitHub issue and pull request state
with a local snapshot, prints JSON or operator text, and exits with a
machine-readable code. Scheduling belongs to cron, an automation system, or the
caller.

The tool does not decide what to do. It only detects changes such as new PRs,
merged PRs, CI status changes, review decision changes, unresolved review
threads, new comments, relabeling, missing objects, and catch-all updates. Your
orchestrator, script, or agent owns the action.

## Requirements

- Node.js 18 or newer.
- GitHub CLI (`gh`) installed and authenticated.
- Read access to the repository being watched.

## Quick Start

Install from npm once published:

```bash
npm install --global gh-delta
gh-delta --help
gh-delta --help-json
gh-delta --version
```

Or run from a source checkout:

```bash
git clone https://github.com/<owner>/gh-delta.git
cd gh-delta
npm install
npm run check

node ./gh-delta.mjs \
  --repo owner/repo \
  --monitor-id prs \
  --state-dir ./state \
  --entities pr \
  --format json
```

The first successful run establishes the baseline and exits `0`. Later runs
compare against that baseline.

For scheduled watcher ticks, use text output:

```bash
node ./gh-delta.mjs \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text
```

To notify an external endpoint when deltas appear, add an HTTP(S) outpost:

```bash
node ./gh-delta.mjs \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text \
  --outpost-url https://example.com/gh-delta
```

## CLI

```bash
gh-delta --repo <owner/name> --monitor-id <id> (--state-dir <dir> | --state-file <path>) [--entities pr,issue] [--format json|text] [--detail] [--outpost-url <url>]
```

Options:

- `--repo`: repository in `owner/name` form. Required.
- `--monitor-id`: stable monitor identity used in reports, event IDs, and
  derived snapshot paths. Required.
- `--state-dir`: directory for a derived snapshot path scoped by repo, monitor
  id, and selected entities. Mutually exclusive with `--state-file`.
- `--state-file`: explicit snapshot JSON path. Mutually exclusive with
  `--state-dir`.
- `--entities`: `pr`, `issue`, or `pr,issue`. Defaults to `pr,issue`. When a
  partial entity set is used, the unrequested side of the snapshot is preserved.
- `--format`: `json` or `text`. Defaults to `json`.
- `--detail`: add a human-readable `line` field to each delta in JSON output.
  Text output adds detail automatically.
- `--outpost-url`: HTTP(S) endpoint that receives one JSON `POST` per delta when
  the detector exits `10`.
- `--help`: print usage.
- `--help-json`: print versioned, machine-readable help for LLMs, agents, and
  other tooling. The top-level `helpSchemaVersion` field starts at `1`.
- `--version`: print the package version from `package.json`.

`gh-delta` never creates schedules, timers, automations, or wake-ups.

Exit codes:

- `0`: baseline established or no deltas.
- `10`: deltas found.
- `1`: argument, GitHub CLI, network, or parse error. On errors, the snapshot is
  not updated.

## Snapshot Identity

With `--state-dir`, the snapshot path is derived from:

```text
repo + monitor-id + entities
```

Example:

```bash
gh-delta --repo org/app --monitor-id prs-5m --state-dir ./state --entities pr
```

uses:

```text
./state/org-app__prs-5m__pr.json
```

Use different `--monitor-id` values for monitors that should keep independent
state. Reusing the same monitor id and entity set points multiple invocations at
the same snapshot.

## Outpost Delivery

`--outpost-url` is optional. Without it, behavior is unchanged. With it,
`gh-delta` validates the URL before fetching GitHub state, then sends one HTTP
`POST` per delta only when the detector exits `10`.

Outpost delivery is fire-and-forget and at-most-once:

- no retries;
- no batching;
- no outbox, JSONL queue, SQLite store, or acknowledgement layer;
- outpost failure, timeout, DNS failure, `4xx`, or `5xx` does not change the
  detector exit code;
- the snapshot has already advanced before outpost delivery is attempted.

The external endpoint is responsible for filtering events, deduplicating by
`eventId`, and executing any downstream action. Outpost logs intentionally avoid
printing endpoint URLs, query strings, headers, or future auth material.

Payload schema v1:

```json
{
  "type": "gh-delta.delta",
  "schemaVersion": 1,
  "eventId": "gh-delta.delta.v1:owner/repo:prs-5m:issue:17:relabeled:2026-07-01T12:00:00.000Z",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
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

`eventId` is deterministic for a given repo, monitor id, entity, number, class
list, and detector timestamp. PR payloads currently use an empty `labels` array
because the PR fetch does not collect labels.

## Report Shape

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

## Watch Loop Use

See [RUNBOOK.md](RUNBOOK.md) for timer-driven loop patterns. The recommended
setup is cron-native: seed the baseline once, then create a recurring scheduler
whose prompt runs one detector pass with `--format text` and stops. Do not call
`ScheduleWakeup` or create another cron from inside a cron-owned tick.

See [docs/watch-loop-prompt.md](docs/watch-loop-prompt.md) for a prompt template
for cron-owned watcher ticks.

Delivery note: successful detections advance the snapshot before any agent
action or outpost finishes. Keep scheduler logs for text output, or add an
external queue if you need at-least-once action delivery.

## Design Notes

`gh-delta` is split into pure logic and impure edges:

- `lib/args.mjs`: shared CLI argument helpers for entity selection and outposts.
- `lib/fingerprint.mjs`: stable fingerprints for PRs and issues.
- `lib/detect.mjs`: compares snapshots and classifies deltas.
- `lib/gh.mjs`: calls `gh pr list`, `gh issue list`, and `gh api graphql` for
  PR review thread counts.
- `lib/snapshot.mjs`: reads and atomically writes snapshot files.
- `lib/outpost.mjs`: validates outpost URLs, builds schema v1 payloads, and
  sends short-timeout HTTP POSTs.
- `lib/text-output.mjs`: formats operator text and outpost warnings.
- `lib/version.mjs`: reads package metadata for `--version` and help JSON.
- `lib/help.mjs`: shared human and machine-readable CLI help metadata.
- `lib/entrypoint.mjs`: symlink-safe bin entrypoint detection for npm/npx.
- `gh-delta.mjs`: CLI wiring, output formats, outposts, and exit codes.

More detail is in [docs/architecture.md](docs/architecture.md).

Current v0.1 scope: the GitHub CLI fetch fails closed if either PR or issue
results hit the hard `500` item limit, or if an open PR has more than 100 review
threads and nested review-thread pagination would be required. Use a narrower
monitor scope or wait for a broader paginated fetcher for larger repositories.

Research for future entity types and selectors lives under
[docs/entities-research](docs/entities-research/README.md). Those notes are not
public CLI contract.

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
