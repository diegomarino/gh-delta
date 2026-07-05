# Programmatic embed

gh-delta **as a library**: the pure detector, the snapshot helpers, and the
contract constants over a fetch you control — here, "watch only issues
labeled `incident`", a scope the CLI's `--entities` cannot express.

```
gh api repos/o/r/issues?labels=incident&state=all   (your fetch, your scope)
   │  map REST rows -> detector row shape
   ▼
detectDeltas(oldSnapshot, { issue: rows })           gh-delta/detect (pure)
   │
   ├─ writeSnapshotAtomic(...)                       gh-delta/snapshot
   ▼
custom digest + CLI-compatible exit code (0 / 10)
```

## Install

None — run it from this checkout:

```bash
node watch-incident-issues.mjs owner/repo            # label defaults to 'incident'
node watch-incident-issues.mjs owner/repo sev1       # any label
```

## The mapping table (the load-bearing part)

Rows handed to `detectDeltas` must match the shape the CLI's fetcher
produces — the fingerprint reads these exact fields:

| REST field (`gh api .../issues`) | Detector row field | Transform                                                                             |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `number`, `title`                | `number`, `title`  | passthrough                                                                           |
| `state` (`'open'`/`'closed'`)    | `state`            | uppercase → `'OPEN'`/`'CLOSED'`                                                       |
| `updated_at`                     | `updatedAt`        | **rename** (snake → camel; forget it and every timestamp-only change goes undetected) |
| `labels` (objects)               | `labels`           | keep only `{ name }`                                                                  |
| `comments` (count)               | `comments`         | passthrough (REST gives the exact total)                                              |
| `pull_request` key present       | —                  | **drop the row** (the issues endpoint includes PRs)                                   |

## Design notes

- **The scope is the point**: filtering by label happens in _your_ fetch;
  the detector just diffs what you hand it and preserves the `pr` side of the
  snapshot untouched (`{ issue: rows }`).
- **Label removal looks like disappearance.** An issue that loses the
  `incident` label vanishes from this fetch, so the detector runs its missing
  lifecycle (`missing` → `still-missing` → `presumed-deleted`, then silence).
  For a label-scoped watcher that reading is arguably correct — "no longer an
  incident" — but know it's there. See
  [delta classes](../../docs/contract.md#delta-classes).
- **Contract constants keep you honest**: the script checks emitted classes
  against `DELTA_CLASSES` and follows the forward-compat clause (unknown
  classes are a note, never an error).
- **Exit codes mirror the CLI** (`0` / `10`, usage error `2`) so cron or any
  wrapper can treat this script exactly like the binary.

## Requirements

Node >= 18, `gh` authenticated, run from a gh-delta checkout (or install the
published package and switch to the `gh-delta/*` imports shown in the file
header).
