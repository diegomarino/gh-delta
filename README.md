# gh-delta <!-- omit in toc -->

[![npm version](https://img.shields.io/npm/v/gh-delta.svg)](https://www.npmjs.com/package/gh-delta)
[![CI](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml/badge.svg)](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml)
[![Node.js: >=18](https://img.shields.io/node/v/gh-delta.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`gh-delta` is a small deterministic GitHub watcher for agent or automation loops.
It runs one detection pass, compares current GitHub issue and pull request state
with a local snapshot, prints JSON or operator text, and exits with a
machine-readable code. Scheduling belongs to cron, an automation system, or the
caller.

The tool does not decide what to do. It only detects changes such as new PRs,
merged PRs, CI status changes, review decision changes, unresolved review
threads, new comments, relabeling, missing objects, and catch-all updates. Your
orchestrator, script, or agent owns the action.

`gh-delta` is not a dashboard, inbox, or PR bot. It is a deterministic GitHub
delta detector for schedulers, scripts, and agent loops.

<p align="center">
  <img src="docs/img/text-output.png" alt="gh-delta reporting two GitHub deltas in text output" width="760">
</p>

## Table of Contents <!-- omit in toc -->

- [Requirements](#requirements)
- [Alternatives and Adjacent Tools](#alternatives-and-adjacent-tools)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Snapshot Identity](#snapshot-identity)
- [Outpost Delivery](#outpost-delivery)
- [Report Shape](#report-shape)
- [Delta Classes](#delta-classes)
- [Watch Loop Use](#watch-loop-use)
- [Programmatic Use](#programmatic-use)
- [Output Samples](#output-samples)
  - [`--format text`](#--format-text)
  - [`--format json`](#--format-json)
  - [`--help-json`](#--help-json)
- [Design Notes](#design-notes)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Requirements

- Node.js 18 or newer.
- GitHub CLI (`gh`) installed and authenticated.
- Read access to the repository being watched.

To validate `gh` auth locally:

```bash
gh auth status
```

## Alternatives and Adjacent Tools

### Closer alternatives

| Project                                                       | What it is                                                                                      | Why it is somewhat close                                | Why `gh-delta` is different                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`openclaw/gitcrawl`](https://github.com/openclaw/gitcrawl)   | Local-first GitHub issue and pull request crawler with SQLite, CLI/JSON/TUI surfaces            | Local-first, CLI-oriented, works from GitHub state      | `gitcrawl` is a broader crawler and triage system; `gh-delta` is narrower and centered on deterministic snapshot-to-snapshot change detection |
| [`yungookim/oh-my-pr`](https://github.com/yungookim/oh-my-pr) | Local-first PR babysitter that watches repos and dispatches AI agents to fix code               | Also watches GitHub state and is automation-oriented    | `oh-my-pr` takes actions and manages agent workflows; `gh-delta` stops at detection and leaves actions to the caller                          |
| [`k1LoW/gh-triage`](https://github.com/k1LoW/gh-triage)       | `gh` extension for triaging issues, pull requests, and discussions through unread notifications | Terminal-native GitHub workflow tool for ongoing triage | Notification-inbox workflow, not deterministic diffing against a local snapshot                                                               |

### Adjacent tools, not near-direct replacements

| Project                                                         | What it is                                                                              | Why it is adjacent                               | Why it is not a near-direct replacement                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`google/triage-party`](https://github.com/google/triage-party) | Stateless self-hosted web app for issue and PR triage                                   | Helps teams react to GitHub activity             | Human-facing web triage UI, not a one-shot machine-readable delta detector                            |
| [`kenn-io/middleman`](https://github.com/kenn-io/middleman)     | Local-first maintainer console and dashboard for triage, review, and merge across repos | Local-first GitHub operations surface            | Interactive dashboard and console rather than a detector primitive for schedulers, scripts, or agents |
| [`meiji163/gh-notify`](https://github.com/meiji163/gh-notify)   | `gh` extension to view GitHub notifications in the terminal                             | Lightweight terminal tool around GitHub activity | Notification reader UX, not snapshot-based state change detection                                     |

## Quick Start

<p align="center">
  <img src="docs/img/usage.png" alt="gh-delta command-line invocation" width="520">
</p>

Minimal zero-config invocation — state and monitor identity are derived automatically (see [Snapshot Identity](#snapshot-identity)):

```bash
gh-delta --repo owner/repo
```

Install from npm once published:

```bash
npm install --global gh-delta
gh-delta --help
gh-delta --help-json
gh-delta --version
```

No install required — run directly with npx:

```bash
npx gh-delta \
  --repo owner/repo \
  --monitor-id prs \
  --state-dir ./state \
  --entities pr \
  --format json
```

Or run from a source checkout:

```bash
git clone https://github.com/diegomarino/gh-delta.git
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

`gh-delta` is intentionally thin and dependency-free at runtime. A minimal
production run for one monitor typically looks like:

```bash
gh-delta --help-json >/tmp/gh-delta-help.json && jq . < /tmp/gh-delta-help.json
gh-delta --repo owner/repo --monitor-id prs-5m --state-dir ./state --entities pr --format text
```

The first successful run establishes the baseline and exits `0`. Later runs
compare against that baseline.

For scheduled watcher ticks, use text output:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text
```

To notify an external endpoint when deltas appear, add an HTTP(S) outpost:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text \
  --outpost-url https://example.com/gh-delta
```

## CLI

```bash
gh-delta --repo <owner/name> [--monitor-id <id>] [--state-file <path> | --state-dir <dir>] [--entities pr,issue] [--format json|text] [--detail] [--outpost-url <url>] [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>] [--gh-timeout-ms <ms>]
```

Options:

- `--repo`: repository in `owner/name` form. Required. **Canonicalized to
  lowercase** — snapshot paths, report echoes, and outpost event IDs always use
  the lowercased form.
- `--monitor-id`: stable monitor identity used in reports, event IDs, and
  derived snapshot paths. Must start with a letter or number and contain only
  letters, numbers, dot, underscore, or dash. **Optional**: defaults to
  `host-` + the first 12 hex characters of the sha1 of the machine hostname —
  stable per machine. A renamed host, container, or CI runner with a per-job
  hostname gets a new id and a fresh baseline; pass `--monitor-id` explicitly
  in CI.
- `--state-dir`: directory for a derived snapshot path scoped by repo, monitor
  id, and selected entities. Optional; mutually exclusive with `--state-file`.
  When neither flag is given, a per-user temp directory under the system temp
  dir is used automatically (ephemeral — reboots or tmp cleanup silently
  re-seed the baseline). Pass `--state-dir` explicitly for durable monitors.
- `--state-file`: explicit snapshot JSON path. Optional; mutually exclusive with
  `--state-dir`.
- `--entities`: `pr`, `issue`, or `pr,issue`. Defaults to `pr,issue`. When a
  partial entity set is used, the unrequested side of the snapshot is preserved.
- `--format`: `json` or `text`. Defaults to `json`.
- `--detail`: add a human-readable `line` field to each delta in JSON output.
  Text output adds detail automatically.
- `--outpost-url`: HTTP(S) endpoint that receives one JSON `POST` per delta when
  the detector exits `10`.
- `--outpost-timeout-ms`: timeout in milliseconds for each outpost POST (default
  `4000`).
- `--outpost-max-posts`: maximum number of outpost POSTs per run (default:
  unlimited).
- `--gh-timeout-ms`: timeout in milliseconds for each `gh` subprocess call
  (default `60000`).
- `--help`: print usage.
- `--help-json`: print versioned, machine-readable help for LLMs, agents, and
  other tooling. The top-level `helpSchemaVersion` field starts at `1`.
- `--version`: print the package version from `package.json`.

**Repeated flags:** the last value wins. **`--help`, `--help-json`, and
`--version` take precedence over all validation.**

`gh-delta` never creates schedules, timers, automations, or wake-ups.

Exit codes: `0` baseline/no deltas, `10` deltas, `1` transient error, `2`
permanent error. See [Exit Codes](docs/contract.md#exit-codes) for full detail.

For scheduled runs, use the cron-native loop guidance in [RUNBOOK.md](RUNBOOK.md) and the [watch-loop prompt](docs/watch-loop-prompt.md).

## Snapshot Identity

When `--state-dir` is given, the snapshot path is derived from:

```text
repo + monitor-id + entities
```

Example:

```bash
gh-delta --repo org/app --monitor-id prs-5m --state-dir ./state --entities pr
```

uses:

```text
./state/repo-org%2Fapp__monitor-prs-5m__pr.json
```

When `--monitor-id` is omitted, it defaults to `host-` + the first 12 hex
characters of the sha1 of the machine hostname — stable per machine and always
grammar-valid. A hostname change (host rename, container, or CI runner with a
per-job hostname) yields a new id and therefore a fresh baseline.

When neither `--state-dir` nor `--state-file` is given, the snapshot lives under
a per-user directory in the system temp dir:

```text
/tmp/gh-delta-<user>/repo-org%2Fapp__monitor-host-<hashed-hostname>__pr.json
```

This default is **ephemeral** — reboots and tmp cleanup silently re-seed the
baseline. The `baseline: true` field in the report (and the baseline line in text
mode) is the signal that the monitor re-seeded. Use `--state-dir` for scheduled
or durable monitors.

Filename segments are encoded with `encodeURIComponent` **plus `_` additionally
encoded as `%5F`** — for example, a repo named `org/my_app` becomes
`repo-org%2Fmy%5Fapp`. This ensures derived names are injective for all valid CLI
inputs.

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

Outpost is best-effort notification. `eventId` is the semantic dedupe key and
`deliveryId` identifies one delivery attempt. `gh-delta` does not provide
reliable delivery, retries, an outbox, acknowledgement, or replay in `0.1`.
The external endpoint is responsible for filtering events, deduplicating by
`eventId`, and executing any downstream action. Outpost logs intentionally
avoid printing endpoint URLs, query strings, headers, or future auth material.

See [Outpost payload schema v1](docs/contract.md#outpost-payload-schema-v1) for the full envelope and `eventId` semantics.

## Report Shape

See [Report Shape](docs/contract.md#report-shape) for the full JSON structure.

## Delta Classes

See [Delta Classes](docs/contract.md#delta-classes) for the full list.

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

## Programmatic Use

`gh-delta` exposes a small subpath-only ESM surface for embedding in orchestrators:

```js
import { detectDeltas } from 'gh-delta/detect';
import {
  canonicalizeCiRollup,
  hashReviews,
  issueFingerprint,
  prFingerprint,
} from 'gh-delta/fingerprint';
import {
  buildOutpostPayload,
  postOutpost,
  sendOutposts,
  validateOutpostUrl,
} from 'gh-delta/outpost';
import {
  readSnapshot,
  snapshotPath,
  writeSnapshotAtomic,
  defaultStateDir,
} from 'gh-delta/snapshot';
import {
  parseEntitySelection,
  validateRepo,
  validateMonitorId,
  canonicalEntityKey,
} from 'gh-delta/args';
import { getPackageMetadata, renderVersionText } from 'gh-delta/version';
import {
  REPORT_SCHEMA_VERSION,
  OUTPOST_SCHEMA_VERSION,
  DELTA_CLASSES,
  ERROR_KINDS,
} from 'gh-delta/contract';
```

The package root is intentionally not exported. Use the `gh-delta` binary for
CLI execution, and import explicit subpaths such as `gh-delta/detect` or
`gh-delta/outpost` for programmatic use. The source file `lib/cli.mjs` is the
internal CLI runner used by the package bin and tests; it is not part of the
published import contract.

TypeScript note: this release is implemented in plain ESM `.mjs` (no TypeScript
source files are shipped). There are no bundled declaration files yet, so TypeScript
consumers should pin to a known `gh-delta` version and add local types if they need
compile-time checking.

| Import                 | Exported names                                                                    | Purpose                            |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| `gh-delta/detect`      | `detectDeltas`                                                                    | Pure delta classification          |
| `gh-delta/fingerprint` | `canonicalizeCiRollup`, `hashReviews`, `issueFingerprint`, `prFingerprint`        | GitHub object fingerprint helpers  |
| `gh-delta/outpost`     | `buildOutpostPayload`, `postOutpost`, `sendOutposts`, `validateOutpostUrl`        | Outpost payload + delivery helpers |
| `gh-delta/snapshot`    | `readSnapshot`, `snapshotPath`, `writeSnapshotAtomic`, `defaultStateDir`          | Snapshot path/read/write helpers   |
| `gh-delta/args`        | `parseEntitySelection`, `validateRepo`, `validateMonitorId`, `canonicalEntityKey` | Shared argument parsing helpers    |
| `gh-delta/version`     | `getPackageMetadata`, `renderVersionText`                                         | Package metadata + version text    |
| `gh-delta/contract`    | `REPORT_SCHEMA_VERSION`, `OUTPOST_SCHEMA_VERSION`, `DELTA_CLASSES`, `ERROR_KINDS` | Runtime contract constants         |

All subpaths are pure ESM (`"type": "module"`). The package has no runtime dependencies.

One confirmed call shape: `buildOutpostPayload({ report, delta })`.

## Output Samples

### `--format text`

Text output consists of an ISO timestamp heartbeat line followed by one block
per delta. Each block has the entity label, the delta classes, and a suggested
action derived from those classes:

```text
2026-07-01T12:00:00.000Z | 2 delta(s)

PR #42 "Add widget": ci-changed, review-changed
classes: ci-changed, review-changed
suggested action: CI/review changed. Read checks and review threads before merge.

ISSUE #17 "Backfill imports": relabeled
classes: relabeled
suggested action: scope/state changed. Reassess dispatch.
```

When no deltas are found the output is:

```text
2026-07-01T12:00:00.000Z | 0 delta(s)

No GitHub deltas since the last snapshot.
```

On error (exit `1` transient):

```text
2026-07-01T12:00:00.000Z | error | 0 delta(s)

gh-delta error: <error message>
Snapshot was not updated. No action taken. The next scheduled tick should retry.
```

On permanent error (exit `2`):

```text
2026-07-01T12:00:00.000Z | error | 0 delta(s)

gh-delta error: <error message>
Snapshot was not updated. Fix the configuration or snapshot; retrying will not help.
```

### `--format json`

The same detection tick, machine-readable. Each delta carries its previous and
current fingerprints as `from`/`to`; see
[Report Shape](docs/contract.md#report-shape) for the full envelope.

<p align="center">
  <img src="docs/img/json-output.png" alt="gh-delta --format json report for a relabeled issue" width="480">
</p>

### `--help-json`

`gh-delta --help-json` prints a versioned machine-readable help document to
stdout. The top-level `helpSchemaVersion` field is `1`. The full document
includes all options, exit codes, output metadata, safety guarantees, and
examples. Excerpt:

```json
{
  "helpSchemaVersion": 1,
  "command": "gh-delta",
  "version": "0.1.0",
  "summary": "Deterministic GitHub issue and pull request delta detector.",
  "usage": "gh-delta --repo <owner/name> [--monitor-id <id>] [--state-file <path> | --state-dir <dir>] [--entities pr,issue] [--format json|text] [--detail] [--outpost-url <url>] [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>] [--gh-timeout-ms <ms>]",
  "purpose": "Run one deterministic detection pass, update the snapshot after a successful fetch, print JSON or operator text, and exit. Scheduling belongs to the caller.",
  "options": [
    {
      "name": "--repo",
      "valueName": "owner/name",
      "type": "string",
      "required": true,
      "description": "GitHub repository in owner/name form."
    },
    {
      "name": "--monitor-id",
      "valueName": "id",
      "type": "string",
      "required": false,
      "description": "Stable monitor identity used in reports, event IDs, and derived snapshot paths. Optional: defaults to a stable per-machine id (host- + hashed hostname). A renamed host — or a CI runner with a per-job hostname — gets a new id and a fresh baseline; pass an explicit id in CI."
    }
  ]
}
```

Run `gh-delta --help-json` to emit the complete document.

## Design Notes

`gh-delta` is split into pure logic and impure edges:

- `lib/args.mjs`: shared CLI argument helpers for entity selection, repo
  validation, and monitor-id validation.
- `lib/fingerprint.mjs`: stable fingerprints for PRs and issues.
- `lib/detect.mjs`: compares snapshots and classifies deltas.
- `lib/gh.mjs`: GraphQL incremental fetcher — open items in full, plus
  all-states items updated since the snapshot horizon.
- `lib/snapshot.mjs`: reads and atomically writes snapshot files; derives
  the incremental-fetch horizon cutoff.
- `lib/outpost.mjs`: validates outpost URLs, builds schema v1 payloads, and
  sends short-timeout HTTP POSTs.
- `lib/text-output.mjs`: formats operator text and outpost warnings.
- `lib/version.mjs`: reads package metadata for `--version` and help JSON.
- `lib/help.mjs`: shared human and machine-readable CLI help metadata.
- `lib/contract.mjs`: runtime contract constants (`REPORT_SCHEMA_VERSION`,
  `OUTPOST_SCHEMA_VERSION`, `DELTA_CLASSES`, `ERROR_KINDS`).
- `lib/entrypoint.mjs`: symlink-safe bin entrypoint detection for npm/npx.
- `lib/cli.mjs`: internal CLI runner used by the package bin and tests.
- `gh-delta.mjs`: the executable bin entrypoint; delegates to `lib/cli.mjs`.

More detail is in [docs/architecture.md](docs/architecture.md).

The fetch uses a GraphQL incremental strategy. Open items are fetched in full
(up to 10 pages × 100 = 1 000 per family; exits `1` beyond that). When a prior
snapshot exists, all-states items updated since the snapshot horizon are also
fetched to observe closed, merged, and relabeled transitions (up to 30 pages ×
100 = 3 000 per tick; exits `1` with guidance to narrow the monitor scope or
re-seed the baseline). Per-item nested pagination (CI contexts, reviews,
review threads, labels) fails closed if a sub-page overflows.

Research for future entity types and selectors lives under
[docs/entities-research](docs/entities-research/README.md). Those notes are not
public CLI contract.

## Troubleshooting / FAQ

**My monitor re-baselined after a reboot.**
The temp-dir default (`<system temp dir>/gh-delta-<user>/...`) is ephemeral by
design — the OS may clear `/tmp` on reboot or on schedule. When the snapshot
file is gone, the next run seeds a fresh baseline: `baseline: true` in the JSON
report (or the baseline line in text mode) is the signal. If you need durable
state that survives reboots, pass `--state-dir` pointing at a persistent
directory. Agent loops and casual CLI runs that can tolerate post-reboot
re-baselines are fine with the default.

**`gh` is not authenticated — exit `1` on first run.**
Run `gh auth status` to verify authentication. `gh-delta` delegates all GitHub
fetches to the `gh` CLI. If `gh` is not authenticated or lacks read access to
the repository, the detector exits `1` and does not touch the snapshot. Fix
authentication first, then retry.

**"exceeded N pages — narrow the monitor scope or re-seed the baseline".**
The tool fails closed (exit `1`) rather than silently truncating results.
Open items are limited to 1 000 per family (10 pages × 100). Updated items per
tick are limited to 3 000 (30 pages × 100); the guidance is to narrow the
monitor scope or re-seed the baseline. Per-item nested pagination (CI contexts,
reviews, review threads, labels) also fails closed if a sub-page overflows.
Narrow the monitor scope (a tighter `--entities` selection, watch a fork, or
split into multiple monitors) before continuing.

**The same delta refires every tick.**
If `gh-delta` repeatedly reports the same delta on every scheduled run, stop
and investigate the underlying GitHub state before taking any action. If an item
has been absent for 3 consecutive ticks, it is demoted to `presumed-deleted` and
goes silent — no further ticks will mention it unless it reappears. Repeated
firing before that demotion is a signal that something unexpected is happening on
the GitHub side or in your monitor configuration.

**An issue I deleted showed `missing` → `still-missing` → `presumed-deleted` — is that a bug?**
No, that is expected behavior. `missing` (tick 1) and `still-missing` (tick 2)
are warnings that an open item vanished from the fetch. `presumed-deleted` (tick 3) is the terminal class — it fires once and then the object goes silent with
memory intact. If the item reappears, `reappeared` fires. If it is truly gone,
silence is correct. You can verify on GitHub; no further action is required from
the monitor.

**Corrupt snapshot / invalid JSON — exit `2`, snapshot not updated.**
If the snapshot file is invalid JSON or has an unrecognized shape, `gh-delta`
exits `2` (permanent error) and leaves the file untouched to preserve monitor
memory. Do not hand-edit snapshot files. If recovery is needed, delete the
snapshot and re-seed the baseline with a fresh first run.

**Snapshot file grows over time on a long-lived monitor.**
Snapshot files retain dormant closed items and archived `presumed-deleted`
fingerprints indefinitely by design — this is what preserves monitor memory
and prevents reappearing items from being treated as new. On very long-lived
active monitors the file grows slowly as new items accumulate. Deleting the
snapshot and re-seeding the baseline is the reset; the next run will treat all
current open items as new.

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

`npm test` imports helper files only; it does not run the live GitHub mutation
cycle. `npm run e2e:playground` is the explicit live acceptance test. It
creates and deletes a real private GitHub repository via `gh`, requires an
authenticated `gh` and network access, and should not run in CI or sandboxes.
See [test/e2e/README.md](test/e2e/README.md).

The project intentionally has no runtime dependencies. Development tooling is
limited to ESLint and Prettier.

See [docs/release-checklist.md](docs/release-checklist.md) before publishing a
new npm release.

Documentation changes should follow behavior changes: if you change CLI flags,
delta classes, snapshot behavior, or any outpost path, update:

- this README;
- [docs/contract.md](docs/contract.md);
- [docs/architecture.md](docs/architecture.md).

## Documentation

| Doc                                                                  | Read it when                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| [RUNBOOK.md](RUNBOOK.md)                                             | Setting up a scheduled watch loop                          |
| [docs/contract.md](docs/contract.md)                                 | You need the exact classes, exit codes, and payload schema |
| [docs/architecture.md](docs/architecture.md)                         | Understanding internals and boundaries                     |
| [docs/watch-loop-prompt.md](docs/watch-loop-prompt.md)               | You want a cron-tick prompt template                       |
| [docs/entities-research/README.md](docs/entities-research/README.md) | Researching future watch entities                          |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                   | Contributing changes                                       |
| [CHANGELOG.md](CHANGELOG.md)                                         | Checking what changed between versions                     |

## License

[MIT](LICENSE) © diegomarino
