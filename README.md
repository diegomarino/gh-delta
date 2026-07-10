# gh-delta <!-- omit in toc -->

[![npm version](https://img.shields.io/npm/v/gh-delta.svg)](https://www.npmjs.com/package/gh-delta)
[![CI](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml/badge.svg)](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml)
[![Node.js: >=18](https://img.shields.io/node/v/gh-delta.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`gh-delta` is a small deterministic GitHub watcher for agent or automation
loops. It runs one detection pass, compares current GitHub issue and pull
request state with a local snapshot, prints JSON or operator text, and exits
with a machine-readable code. Scheduling belongs to cron, an automation system,
or the caller.

The tool does not decide what to do. It only detects changes such as new PRs,
merged PRs, CI status changes, review decision changes, unresolved review
threads, new comments, relabeling, missing objects, and catch-all updates. Your
orchestrator, script, or agent owns the action.

`gh-delta` is not a dashboard, inbox, or PR bot. It is a deterministic GitHub
delta detector for schedulers, scripts, and agent loops.

See [Alternatives and adjacent tools](docs/alternatives.md) for how `gh-delta`
compares to related projects.

<p align="center">
  <img src="docs/img/demo.svg" alt="gh-delta seeding a zero-config baseline, then reporting two GitHub deltas on the next tick" width="820">
</p>

## Table of Contents <!-- omit in toc -->

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Output](#output)
- [Watch Loops and Outposts](#watch-loops-and-outposts)
- [Programmatic Use](#programmatic-use)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Requirements

- Node.js 18 or newer.
- GitHub CLI (`gh`) installed and authenticated.
- Read access to the repository being watched.
- Any OS: Linux and macOS get the POSIX guarantees (and Linux is what CI
  exercises); Windows works with documented caveats — see
  [Platform Notes](docs/contract.md#platform-notes).

To validate `gh` auth locally:

```bash
gh auth status
```

## Quick Start

<p align="center">
  <img src="docs/img/usage.svg" alt="gh-delta zero-config command-line invocation seeding a baseline" width="560">
</p>

Minimal zero-config invocation:

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

No install required:

```bash
npx gh-delta --repo owner/repo --monitor-id prs --state-dir ./state --entities pr --format text
```

Or run from a source checkout:

```bash
git clone https://github.com/diegomarino/gh-delta.git
cd gh-delta
npm install
npm run check

node ./gh-delta.mjs --repo owner/repo --monitor-id prs --state-dir ./state --entities pr --format json
```

The first successful run establishes the baseline and exits `0`. Later runs
compare against that baseline. Use an explicit `--state-dir` for durable
monitors; the zero-config state location is intentionally convenient but can be
cleared by tmp cleanup.

For installation modes, repeated runs, snapshots, outposts, and examples, read
the [Usage Guide](docs/usage.md). For the exact CLI contract, use
[`gh-delta --help-json`](docs/contract.md#cli) or [docs/contract.md](docs/contract.md).

## Core Concepts

- `gh-delta` runs one detector pass and exits. Cron, CI, systemd, an agent, or an
  external automation system owns the schedule.
- The snapshot is local state. A baseline run seeds it; later runs compare
  GitHub state against it.
- `--monitor-id` names a recurring monitor. Reuse it for the same watcher and
  use different ids for independent watchers.
- Exit code `10` means deltas were found. Exit code `0` means baseline/no
  deltas. Error behavior is specified in [Exit Codes](docs/contract.md#exit-codes).
- `--format json` is the machine contract. `--format text` is an operator log
  format.
- `gh-delta list` is a read-only inventory of the monitors that have run on
  this machine — which repo, monitor id, and entities, when each last ran, and
  whether its snapshot is healthy. Every successful run leaves a best-effort
  registry breadcrumb (opt out with `--no-registry`) so `list` sees monitors in
  any state location. It never contacts GitHub and never touches snapshots.

Exact CLI flags, report fields, delta classes, snapshot semantics, and outpost
payloads live in [docs/contract.md](docs/contract.md).

## Output

Text output is designed for scheduled logs:

<p align="center">
  <img src="docs/img/text-output.svg" alt="gh-delta --format text report for a changed PR and a relabeled issue" width="720">
</p>

JSON output is designed for programs and agents:

<p align="center">
  <img src="docs/img/json-output.svg" alt="gh-delta --format json --detail report for a PR with CI and review changes" width="520">
</p>

Use `--summary-line` when an agent only needs a display sentence. Use `--detail`
when it also needs structured class-level explanations. The full report shape is
specified in [Report Shape](docs/contract.md#report-shape), and practical output
examples are in [docs/usage.md](docs/usage.md#output).

### Semantic summaries (`--summaries`)

The per-delta `from`/`to` fingerprints are opaque digests tuned for change
_detection_ — correct for "did CI change?" but useless for "is CI green?". Pass
`--summaries` to add a normalized, typed `summary` object to every PR delta that
has an observed `to` state. It is derived from the **same single observation**
that produced the fingerprints (no second GitHub fetch), and is a **sibling** of
`to`, so the content-addressed `delta.id` and every existing field stay
byte-identical whether or not the flag is set. Consumers may treat it as a hint
and still re-derive authoritative facts themselves.

```jsonc
"summary": {
  // 'none' means ZERO checks ran — never conflated with 'green'. Fail-closed
  // consumers decide what "no CI" means. Precedence is failed > pending > green.
  "ciRollup": "green" | "failed" | "pending" | "none",
  // 'none' also covers "no review-required rule" and "required but none submitted
  // yet"; GitHub does not distinguish these without a branch-protection fetch.
  "reviewDecision": "approved" | "changes_requested" | "review_required" | "none",
  // 'unknown' = GitHub has not finished recomputing mergeability (kept honest,
  // never collapsed to a boolean).
  "mergeable": "mergeable" | "conflicting" | "unknown",
  "state": "open" | "closed" | "merged",
  "isDraft": true,                    // boolean
  "unresolvedReviewThreads": 0,       // non-negative integer
  "headSha": "<head commit SHA, or '' if unobserved>"
}
```

Issue deltas and the missing lifecycle (`to` is null) carry no `summary`. The
field set and enum domains are also emitted machine-readably under
`output.deltaSummaryFields` / `output.deltaSummaryEnums` in `--help-json`, and the
authoritative schema lives in
[Delta Summary schema](docs/contract.md#delta-summary-schema).

## Watch Loops and Outposts

See [RUNBOOK.md](RUNBOOK.md) for timer-driven loop patterns. The recommended
setup is cron-native: seed the baseline once, then create a recurring scheduler
whose prompt runs one detector pass and stops.

See [docs/watch-loop-prompt.md](docs/watch-loop-prompt.md) for a prompt template
for cron-owned watcher ticks.

`--outpost-url` sends one best-effort HTTP notification per delta. `gh-delta`
does not provide retries, an outbox, acknowledgement, replay, or action routing;
the receiving endpoint owns filtering, dedupe, and downstream action. Read the
[Usage Guide](docs/usage.md#outpost-delivery) for a worked command and the
[Outpost Payload](docs/contract.md#outpost-payload-schema-v1) contract for the
exact envelope.

Worked schedulers and receivers live in
[examples/](https://github.com/diegomarino/gh-delta/tree/main/examples) in the
source repository. Examples are GitHub documentation and are not shipped in the
npm package.

## Programmatic Use

`gh-delta` exposes a small subpath-only ESM surface for embedding in
orchestrators:

```js
import { detectDeltas } from 'gh-delta/detect';
import { REPORT_SCHEMA_VERSION } from 'gh-delta/contract';
```

The package root is intentionally not exported. Use the `gh-delta` binary for
CLI execution, and import explicit subpaths such as `gh-delta/detect` or
`gh-delta/outpost` for programmatic use. See
[Programmatic API Surface](docs/contract.md#programmatic-api-surface) for the
complete import contract and [docs/usage.md](docs/usage.md#programmatic-use) for
practical notes.

## Troubleshooting

Common failure symptoms include: monitor re-baselined after a reboot, `gh` auth
failures, page-cap errors, and corrupt snapshots.

See [Troubleshooting / FAQ](docs/troubleshooting.md) for symptoms, causes, and
fixes, including how to locate your snapshot file on Linux and macOS.

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
cycle. `npm run e2e:playground` is the explicit live acceptance test. It creates
and deletes a real private GitHub repository via `gh`, requires an authenticated
`gh` and network access, and should not run in CI or sandboxes. See
[test/e2e/README.md](test/e2e/README.md).

The project intentionally has no runtime dependencies. Development tooling is
limited to ESLint and Prettier.

See [docs/release-checklist.md](docs/release-checklist.md) before publishing a
new npm release.

Documentation changes should follow behavior changes: if you change CLI flags,
delta classes, snapshot behavior, or any outpost path, update:

- [docs/contract.md](docs/contract.md) first — it is the canonical source for
  all CLI options, delta classes, exit codes, report shape, and outpost schema;
- [docs/usage.md](docs/usage.md), for user-facing recipes and operating notes;
- this README, for the top-level route into the project;
- [docs/architecture.md](docs/architecture.md), for internals and rationale
  only.

## Documentation

| Doc                                                                              | Read it when                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [docs/usage.md](docs/usage.md)                                                   | Installing, running, reading output, and wiring practical integrations  |
| [RUNBOOK.md](RUNBOOK.md)                                                         | Setting up a scheduled watch loop                                       |
| [docs/contract.md](docs/contract.md)                                             | You need the exact classes, exit codes, CLI flags, and payload schema   |
| [docs/architecture.md](docs/architecture.md)                                     | Understanding internals, boundaries, and design rationale               |
| [docs/watch-loop-prompt.md](docs/watch-loop-prompt.md)                           | You want a cron-tick prompt template                                    |
| [examples/README.md](https://github.com/diegomarino/gh-delta/tree/main/examples) | You want source-repo worked integrations — cron/CI/systemd/push/library |
| [docs/troubleshooting.md](docs/troubleshooting.md)                               | Something misbehaves                                                    |
| [docs/alternatives.md](docs/alternatives.md)                                     | Comparing `gh-delta` to other tools                                     |
| [docs/entities-research/README.md](docs/entities-research/README.md)             | Researching future watch entities                                       |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                               | Contributing changes                                                    |
| [CHANGELOG.md](CHANGELOG.md)                                                     | Checking what changed between versions                                  |

## License

[MIT](LICENSE) © diegomarino
