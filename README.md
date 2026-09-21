# gh-delta

[![npm version](https://img.shields.io/npm/v/gh-delta.svg)](https://www.npmjs.com/package/gh-delta)
[![CI](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml/badge.svg)](https://github.com/diegomarino/gh-delta/actions/workflows/ci.yml)

`gh-delta` is a deterministic, one-shot GitHub pull-request and issue detector
for schedulers, scripts, and agent loops. It compares a current observation to
a local snapshot, emits deltas, and leaves the next action to its caller. It is
not a dashboard, inbox, bot, or scheduler.

## Install

Node 18+ and authenticated GitHub CLI access are required.

```bash
# npm binary
npm install --global gh-delta

# GitHub CLI extension
gh extension install diegomarino/gh-delta
gh delta --version

# agent decision guide
npx skills add diegomarino/gh-delta
```

For a one-off run, use `npx gh-delta`. The skill is guidance only: it does not
authorize GitHub mutations.

## Quick start

In a GitHub checkout, create durable local monitor state and take a first tick:

```bash
gh-delta init --state-dir .gh-delta
gh-delta --format compact
```

`init` writes a non-overwriting `.gh-delta.json` after a baseline. Later ticks
reuse that identity. A first run exits `0`; a changed run exits `10`; exit `1`
is retryable; exit `2` needs configuration or snapshot repair. JSON is always
the default. Use `--format compact` for bounded agent context and `--format
text` for operator logs.

## What an agent usually does

| Class                                       | Meaning                             | Usual agent response                                                    |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `new`, `first-seen`                         | New or newly observed work          | Inspect and queue the item; do not assume ownership.                    |
| `ci-changed`                                | CI state changed                    | Green: inspect review/merge state. Failed: relay the failing check.     |
| `review-changed`, `review-requests-changed` | Review decision or audience changed | Notify the right reviewer or return requested changes to the worker.    |
| `head-changed`, `base-changed`              | Code or target base changed         | Re-check CI and reviews before trusting earlier approval.               |
| `merged`, `closed`, `reopened`              | Lifecycle changed                   | Verify it, then propose branch/work-queue follow-up.                    |
| `new-comments`, `unresolved-threads-added`  | New discussion needs attention      | Read the discussion before merge or dispatch.                           |
| `became-mergeable`, `became-conflicting`    | Mergeability changed                | Inspect protections/conflicts; never merge only because CI is green.    |
| `stale`                                     | No meaningful change for a period   | Send one bounded reminder to the current owner/reviewer.                |
| `missing`, `presumed-deleted`, `reappeared` | Observation continuity changed      | Check scope/permissions; only treat the terminal class as gone.         |
| `updated`, `relabeled`, `assignees-changed` | Other meaningful metadata changed   | Reassess routing and inspect GitHub when the delta lacks enough detail. |

The [contract](docs/contract.md) is canonical for class semantics, exit codes,
schemas, snapshots, and every flag.

## One agent pattern

Wait for a PR’s CI without polling from an LLM turn:

```bash
gh-delta wait --repo owner/repo --monitor-id worker-42 \
  --state-dir .gh-delta --entities pr --timeout 30m \
  --until-summary ciRollup=green,failed
```

On exit `10`, inspect the JSON `reason` (`until` or `already-satisfied`) and
the PR before proposing a next action. See the runnable,
network-free [agent worker example](examples/agent-worker-wait/README.md) and
the [fan-out coordinator](examples/coordinator-fanout/README.md) for one-fetch,
many-worker operation.

## Docs

- [Usage](docs/usage.md): installation variants, state identity, watch/outpost
  operation, and programmatic use.
- [Recipes](docs/recipes.md): ten copyable situation → command → response flows.
- [Troubleshooting](docs/troubleshooting.md): auth, snapshots, logs, and errors.
- [Examples](examples/README.md): deterministic local example smokes and
  integration shapes.
- [Agent watch-loop prompt](docs/watch-loop-prompt.md): scheduler-owned loop.
- [Architecture](docs/architecture.md) and [release checklist](docs/release-checklist.md): maintainers.

The official GitHub Action and Homebrew tap are external publication work; this
repository ships only the safe local integration shapes until those artifacts
exist.

## License

[MIT](LICENSE)
