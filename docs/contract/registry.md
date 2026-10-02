# Run Registry

[Documentation](../README.md) · [Contract reference](../contract.md)

The registry is how `gh-delta list` sees monitors whose snapshots live outside
any directory it could guess — an arbitrary `--state-dir` or an explicit
`--state-file`. After every resolved detector attempt, including a failure, the
CLI writes one small breadcrumb per monitor:

- **Location:** `$GH_DELTA_REGISTRY_DIR` when set, otherwise
  `$XDG_STATE_HOME/gh-delta/registry`, falling back to
  `~/.local/state/gh-delta/registry`. Durable on purpose — unlike the temp-dir
  snapshot default, a reboot must not erase the inventory.
- **Shape:** one JSON file per monitor, keyed by a sha256 hash of the canonical
  snapshot path (case-folded on Windows; see [Platform Notes](platforms.md#platform-notes)), containing `registryVersion`, `repo`, `monitorId`, `entities`,
  `stateFile`, `lastRun`, `machineId`, `lastAttemptAt`, `lastOkAt`, and
  `lastError` (the field catalog is `REGISTRY_ENTRY_FIELDS` in
  `gh-delta/contract`). Re-registering the same monitor overwrites its own
  file (temp file + atomic rename): idempotent, last-writer-wins, and
  concurrent monitors never share a file — no locks.
- **Best-effort:** a registry write failure is silent and never changes the
  detector report, exit code, or snapshot. The registry is an **index, not
  detector state**: deleting the directory is always safe; it rebuilds as
  monitors run, and losing it never causes false deltas or re-baselines.
- **Opt-out:** `--no-registry` per run, or `GH_DELTA_NO_REGISTRY=1` in the
  environment (hermetic CI, ephemeral containers).
- The detector never deletes registry entries. `gh-delta list` reports orphans
  as `stale: true`; cleanup is a future explicit command.
- **Programmatic use is unaffected:** the registry lives in the CLI layer.
  Importing `gh-delta/detect`, `gh-delta/snapshot`, or any other subpath never
  touches it. Orchestrators that want their embedded monitors to appear in
  `gh-delta list` can opt in via `registerMonitor` from `gh-delta/registry`.
