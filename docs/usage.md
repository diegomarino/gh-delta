# Usage Guide

This guide is the practical companion to the canonical
[contract](contract.md). It shows how to run `gh-delta` in ordinary workflows
without restating every flag, field, or schema. When a value must be exact, link
to the contract or run `gh-delta --help-json`.

## Install and Run

Install globally once published:

```bash
npm install --global gh-delta
gh-delta --version
gh-delta --help
```

Run without installing:

```bash
npx gh-delta --repo owner/repo
```

Run from a source checkout:

```bash
git clone https://github.com/diegomarino/gh-delta.git
cd gh-delta
npm install
npm run check

node ./gh-delta.mjs --repo owner/repo --format text
```

The exact CLI reference lives in [CLI](contract.md#cli). The
machine-readable version is emitted by:

```bash
gh-delta --help-json
```

## First Baseline and Repeated Runs

The first successful run seeds a local snapshot and exits `0`:

```bash
gh-delta --repo owner/repo --monitor-id prs-5m --state-dir ./state --entities pr
```

Later runs with the same repo, monitor id, state location, and entity set compare
GitHub state against that snapshot. A durable monitor should pass `--state-dir`
or `--state-file` explicitly; the zero-config temp-dir default is useful for
ad-hoc checks but can re-baseline after reboot or tmp cleanup.

For scheduled logs, prefer text output:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text
```

For programs and agents, prefer JSON output:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format json \
  --detail
```

Branch on the process exit code before reading stdout. Exit `10` is the
delta-found signal, not a process failure. See [Exit Codes](contract.md#exit-codes).

## Snapshot Identity

Think of `--monitor-id` as the stable name of one recurring watcher. Use the same
id for repeated ticks of the same monitor and a different id when you want
independent state.

```bash
gh-delta --repo org/app --monitor-id prs-5m --state-dir ./state --entities pr
```

With `--state-dir`, `gh-delta` derives a snapshot path from the repo, monitor id,
and selected entities. With `--state-file`, you provide the exact path. With
neither flag, `gh-delta` uses a per-user temp directory and reports the resolved
path in the output.

Exact path derivation, filename encoding, default monitor-id behavior, and
snapshot shape are specified in [Snapshot Semantics](contract.md#snapshot-semantics).

## Listing Monitors

`gh-delta list` answers "which monitors have run here, and when?" without
touching anything: it decodes the derived snapshot filenames in one state
directory and reports each monitor's repo, monitor id, entities, last run, and
stored object counts. It never contacts GitHub and never creates, updates, or
deletes snapshots, so it is safe to run while monitors tick.

```bash
gh-delta list --state-dir ./state --format text
```

Add `--since` to keep only monitors that ran recently:

```bash
gh-delta list --state-dir ./state --since 24h --format text
```

Without `--state-dir`, `list` inventories the zero-config temp-dir location the
detector uses by default. A corrupt snapshot shows up as an entry with an error
instead of failing the listing, which makes `list` a quick health check for a
shared state directory. Only derived snapshots are discoverable; a monitor
using an explicit `--state-file` is not listed. The exact flags and report
shape are specified in [gh-delta list](contract.md#gh-delta-list).

## Watch Loop Use

`gh-delta` does not create timers. A scheduler should invoke one detector pass,
record the output, and stop.

The cron-oriented setup is:

1. Seed the baseline once with the same command the scheduler will use.
2. Run the command periodically under cron, systemd, CI, or an agent scheduler.
3. Treat exit `10` as "inspect deltas" and exit `1` as "retry later."
4. Avoid overlapping ticks against the same snapshot file; use scheduler-level
   locking if overlap is possible.

See [RUNBOOK.md](../RUNBOOK.md) for the full scheduled-loop setup and
[watch-loop-prompt.md](watch-loop-prompt.md) for a cron-owned prompt template.

Worked schedulers live in
[examples/](https://github.com/diegomarino/gh-delta/tree/main/examples) in the
source repository. Examples are GitHub documentation and are not shipped in the
npm package.

## Outpost Delivery

Add `--outpost-url` when you want an external endpoint to receive one
notification per delta:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir ./state \
  --entities pr \
  --format text \
  --outpost-url https://example.com/gh-delta
```

Outposts are best-effort notifications. The detector snapshot advances before
delivery is attempted, and downstream systems own filtering, dedupe, retries,
queues, and actions. Keep scheduler logs or add an external queue if you need
at-least-once action delivery.

The exact payload, `eventId`, `deliveryId`, and warning semantics are specified
in [Outpost Payload](contract.md#outpost-payload-schema-v1).

Worked receiver:
[examples/outpost-ntfy-receiver/](https://github.com/diegomarino/gh-delta/tree/main/examples/outpost-ntfy-receiver)
in the source repository.

## Programmatic Use

Use explicit ESM subpaths. The package root is intentionally not exported.

```js
import { detectDeltas } from 'gh-delta/detect';
import { buildOutpostPayload } from 'gh-delta/outpost';
import { REPORT_SCHEMA_VERSION } from 'gh-delta/contract';
```

Use the binary for CLI execution and subpaths for embedding pieces in an
orchestrator. The full import table lives in
[Programmatic API Surface](contract.md#programmatic-api-surface).

This release ships plain ESM `.mjs` files and no bundled TypeScript declaration
files. TypeScript consumers should pin to a known `gh-delta` version and add
local types if they need compile-time checking.

## Output

Text output consists of an ISO timestamp heartbeat line followed by one block per
delta:

```text
2026-07-01T12:05:00.000Z | 2 delta(s)

PR #42 "Add billing webhook": ci-changed, review-changed
classes: ci-changed, review-changed
suggested action: CI/review changed. Read checks and review threads before merge.

ISSUE #17 "Backfill customer imports": relabeled
classes: relabeled
suggested action: scope/state changed. Reassess dispatch.
```

When no deltas are found:

```text
2026-07-01T12:00:00.000Z | 0 delta(s)

No GitHub deltas since the last snapshot.
```

JSON output carries the machine-readable report. Use `--summary-line` for a
human display sentence and `--detail` for structured class-level explanations.
The exact JSON shape is specified in [Report Shape](contract.md#report-shape).

`gh-delta --help-json` prints machine-readable help for agents and other tooling.
It is the right source for generated CLIs, prompts, and monitors that need the
current command surface.

## Troubleshooting Pointers

Common symptoms:

- A monitor re-baselines after reboot: use explicit `--state-dir`.
- `gh` auth fails: run `gh auth status` in the same environment as the monitor.
- Page-cap errors: narrow the monitor scope or re-seed intentionally.
- Snapshot is corrupt: fix or remove the snapshot after confirming the monitor.

See [Troubleshooting / FAQ](troubleshooting.md) for the full list.
