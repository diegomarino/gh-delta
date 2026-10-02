# Module Responsibilities

[Documentation](../README.md) · [Architecture by responsibility](../architecture.md)

The core correctness logic is pure:

- `args.mjs` parses reusable CLI argument policy without touching process I/O.
- `fingerprint.mjs` converts GitHub objects into stable fingerprints.
- `detect.mjs` compares fingerprints and emits delta classes.

The impure edges are isolated:

- `gh.mjs` shells out to `gh api graphql` for incremental GraphQL fetches.
- `snapshot.mjs` performs filesystem I/O, derives monitor-scoped snapshot paths,
  and computes the incremental-fetch horizon cutoff.
- `deltalog.mjs` owns opt-in append-only NDJSON validation, sequencing, a
  manifest-published reader boundary, generation-based retention compaction,
  crash-tail recovery, log path derivation, and atomic consumer cursors.
- `outpost.mjs` validates optional outpost URLs, builds payloads, and sends
  short-timeout HTTP POSTs.
- `compact-output.mjs` owns pure compact/NDJSON agent rendering and `diff.mjs`
  owns bounded semantic fingerprint diffs; `schema.mjs` derives published JSON
  Schemas from the runtime catalogs.
- `text-output.mjs` formats heartbeat text, list inventory text, and outpost
  warnings.
- `list.mjs` builds the read-only monitor inventory for `gh-delta list`:
  decodes derived snapshot filenames, recognizes self-describing snapshot
  `meta` identity, and merges run-registry entries without writing anything.
- `registry.mjs` owns the run-registry boundary: one atomic breadcrumb file per
  monitor in a fixed per-user directory, written best-effort after each
  successful run and read back by `list`.
- `version.mjs` reads package metadata for version output and help JSON.
- `help.mjs` keeps human `--help` and machine-readable `--help-json` output in
  one versioned source of truth.
- `entrypoint.mjs` detects direct CLI invocation through real paths so npm/npx
  `.bin` symlinks start the package bin correctly.
- `lib/cli.mjs` is a compatibility facade with explicit re-exports only.
  Its internal modules under `lib/cli/` own orchestration and rendering.
- `gh-delta.mjs` is the executable bin entrypoint only. It delegates to
  `lib/cli.mjs` and does not define a public import surface.

## Internal CLI modules

Paths below are relative to `lib/cli/`. These modules are internal; the package
export map and the seven exports from the `lib/cli.mjs` facade stay unchanged.

| Module                     | Responsibility                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `parse.mjs`                | Option tables, parser/help/version handling, format sniffing, numeric and selection parsing, and explicit repository selection. |
| `errors.mjs`               | Error exit codes, hints, and structured error results.                                                                          |
| `config.mjs`               | Configuration dependency selection, monitor selection, registry opt-out policy, and configured command parsing.                 |
| `delta-details.mjs`        | Delta summary lines and field details.                                                                                          |
| `attention.mjs`            | Pure attention filters, ignored-author decisions, and terminal-watch cleanup eligibility.                                       |
| `commands/watch.mjs`       | Watch add, remove, and list handlers.                                                                                           |
| `commands/inventory.mjs`   | List and status handlers, including status refresh.                                                                             |
| `commands/cursor.mjs`      | Read and cursor-set handlers with shared cursor-lock options.                                                                   |
| `commands/maintenance.mjs` | Log compaction, reset, and snapshot deletion.                                                                                   |
| `commands/dx.mjs`          | Init, doctor, explain, demo, and command-generation helpers.                                                                    |
| `commands/schema.mjs`      | Schema command handler.                                                                                                         |
| `commands/wait.mjs`        | Wait validation, matching, heartbeat handling, and bounded-wait orchestration.                                                  |
| `detector.mjs`             | One synchronous repository transaction, including locks, persistence, watch cleanup, and enrichment.                            |
| `multi-repo.mjs`           | Aggregate errors, multi-repository preflight validation, and report envelopes.                                                  |
| `runner.mjs`               | Dispatch, configuration call sites, serial repository execution, outpost delivery, and command execution.                       |
| `render.mjs`               | Completed command results with stdout/stderr strings for each output format.                                                    |

Imports flow from the facade to the runner, from the runner to command handlers,
the detector and rendering, and from those modules to shared policies and the
existing core modules. Internal modules never import the facade or runner.
The runner supplies `{ run }` to `init` and `wait`, allowing their nested ticks
to use the same injected dependencies without an import cycle. Status refresh
calls the detector directly because it needs the raw per-repository result.

`run` remains synchronous. `runWithOutpost` and `runCommand` remain asynchronous.
Dependency defaults are evaluated at their original command call sites. The
detector keeps lock acquisition, ownership checks, durable-log publication,
snapshot publication, watch cleanup, enrichment, and final lock release in one
function and in their existing order. Single-repository validation and
multi-repository preflight validation remain separate.

## Package Surface

The npm package exposes one CLI and a small explicit ESM import surface. The
package root is intentionally not exported; supported programmatic imports use
subpaths such as `gh-delta/detect` and `gh-delta/outpost`.

The canonical import list lives in
[Programmatic API Surface](../contract/programmatic-api.md#programmatic-api-surface). Keeping it
there avoids a second exports table drifting from `package.json`.

Everything under `lib/` should stay dependency-free unless the added dependency
materially improves correctness. The package currently has no runtime
dependencies.
