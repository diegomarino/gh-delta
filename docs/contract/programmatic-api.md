# Programmatic API Surface

[Documentation](../README.md) · [Contract reference](../contract.md)

The package publishes a small, explicit ESM surface. Imports must use explicit
subpaths; the package root is intentionally not exported.

| Export path               | Symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Purpose                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `gh-delta/detect`         | `detectDeltas`, `threadSetDiff`, `threadReplyIncrements`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Pure delta classification engine                              |
| `gh-delta/diff`           | `diffFingerprint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bounded, pure `delta.changed` fingerprint diff                |
| `gh-delta/deltalog`       | `deltaLogPath`, `appendDeltaLog`, `readDeltaLog`, `compactDeltaLog`, `readCursor`, `setCursorAtomic`, `resetDeltaLog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Durable NDJSON journal and atomic consumer cursors            |
| `gh-delta/fingerprint`    | `prFingerprint`, `issueFingerprint`, `buildChecks`, `buildReviews`, `buildThreads`, `stableValue`, `deltaIdentity`, `deltaId`, `parseActionsRunJob`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Stable object fingerprint builders and delta-id hashing       |
| `gh-delta/duration`       | `parseDuration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared duration grammar for every duration-valued flag        |
| `gh-delta/wait`           | `runBoundedWait`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Bounded worker loop over caller-supplied complete ticks       |
| `gh-delta/list`           | `listMonitors`, `parseSnapshotFilename`, `parseSince`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Read-only monitor snapshot inventory                          |
| `gh-delta/registry`       | `registerMonitor`, `readRegistry`, `defaultRegistryDir`, `registryEntryPath`, `canonicalStateFileKey`, `REGISTRY_VERSION`, `defaultMachineId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Run-registry breadcrumbs for gh-delta list                    |
| `gh-delta/outpost`        | `buildOutpostPayload`, `outpostSignature`, `validateOutpostUrl`, `postOutpost`, `sendOutposts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Outpost payload and transport helpers                         |
| `gh-delta/snapshot`       | `readSnapshot`, `snapshotPath`, `economicalSnapshotPath`, `writeSnapshotAtomic`, `defaultStateDir`, `horizonCutoff`, `SNAPSHOT_SCHEMA_VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Snapshot path and persistence helpers                         |
| `gh-delta/lock`           | `acquireLock`, `releaseLock`, `assertLockOwned`, `lockPath`, `LOCK_EXPIRY_SLACK_MS`, `extendLockDeadline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | State-file lock: one writer per `(repo, monitorId, entities)` |
| `gh-delta/args`           | `parseEntitySelection`, `validateRepo`, `validateMonitorId`, `canonicalEntityKey`, `defaultMonitorId`, `parseIgnoreAuthors`, `parseEnrichmentSelection`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Shared argument parsing policies                              |
| `gh-delta/version`        | `getPackageMetadata`, `renderVersionText`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Package metadata and version output                           |
| `gh-delta/config`         | `applyConfig`, `CONFIG_KEYS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Local configuration and flag-precedence helpers               |
| `gh-delta/dx`             | `initializeMonitor`, `writeConfigDurableNoOverwrite`, `runDoctorChecks`, `explainDelta`, `isTemporaryPath`, `defaultStateDirInspection`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Local init, diagnostics, and persisted-delta explanation      |
| `gh-delta/compact-output` | `compactDelta`, `compactReport`, `ndjsonReport`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agent-oriented compact/NDJSON render shapes                   |
| `gh-delta/schema`         | `schemaFor`, `DELTA_CORE_REQUIRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Draft-2020-12 JSON Schema generation for `gh-delta schema`    |
| `gh-delta/watch`          | `watchDirPath`, `parseWatchItem`, `watchFilename`, `readWatch`, `addWatch`, `listWatch`, `removeWatch`, `removeWatchUnchanged`, `markTerminalIgnored`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bounded-watch directory entries for `--until`                 |
| `gh-delta/contract`       | `REPORT_SCHEMA_VERSION`, `OUTPOST_SCHEMA_VERSION`, `REPORT_FIELDS`, `REPORT_RESULT_FIELDS`, `DELTA_FIELDS`, `DELTA_CONTEXT_FIELDS`, `DELTA_DETAIL_FIELDS`, `DELTA_DETAIL_FIELDS_BY_CLASS`, `DELTA_CLASSES`, `ERROR_KINDS`, `LIST_REPORT_FIELDS`, `LIST_MONITOR_FIELDS`, `REGISTRY_ENTRY_FIELDS`, `DELTA_SUMMARY_FIELDS`, `DELTA_SUMMARY_ENUMS`, `DELTA_LOG_RECORD_FIELDS`, `CURSOR_FILE_FIELDS`, `READ_REPORT_FIELDS`, `READ_CURSOR_FIELDS`, `COMPACT_REPORT_FIELDS`, `COMPACT_BOUNDS_FIELDS`, `RESET_REPORT_FIELDS`, `RESET_TARGET_FIELDS`, `CURSOR_SET_REPORT_FIELDS`, `CURSOR_SET_CURSOR_FIELDS`, `WAIT_REPORT_FIELDS`, `AGENT_COMPACT_REPORT_FIELDS`, `AGENT_COMPACT_DELTA_FIELDS`, `AGENT_NDJSON_END_FIELDS` | Runtime contract constants and field catalogs                 |

Behavioral notes for consumers:

- `detectDeltas` is pure: pass old and current collections and consume
  `baseline`, `deltas`, and replacement `snapshot`.
- `diffFingerprint(from, to, { arrayLimit = 20 })` builds the bounded `changed`
  diff every delta carries: identity-keyed arrays (`reviews`, `threads`,
  `recentComments`) name added/removed/changed rows by `id`; `checks` names
  `failed`/`fixed`/`changed` by check name; set-style string arrays (`labels`,
  `assignees`, `reviewRequests`) name added/removed; everything else is a
  scalar `{from, to}` transition. Every array result caps at `arrayLimit`
  entries and adds `truncated: true` past that bound.
- `buildOutpostPayload` already includes a deterministic `deliveryId` (send-attempt
  identity) and a fallback content-addressed `delta.id` when the caller's delta
  does not already carry one (see [Outpost Payload](outpost.md#outpost-payload-schema-v2)).
- `postOutpost` throws on HTTP failures so callers can classify transport errors.
- `readSnapshot` throws on malformed JSON or a `meta.schemaVersion` other than
  the current `SNAPSHOT_SCHEMA_VERSION`; callers should treat this as
  recoverable only via `gh-delta reset`, never by migrating the file in place.
- `parseDuration(raw, { flag })` is the single implementation of the duration
  grammar (a positive integer followed by `s`, `m`, `h`, or `d`). `parseSince` is
  a thin wrapper over it that fixes `flag` to `--since`; every future
  duration-valued flag must use `parseDuration` rather than restate the grammar.
- `appendDeltaLog` fsyncs complete NDJSON records, then atomically publishes a
  versioned reader boundary; `readDeltaLog` validates every published record and
  never exposes an unpublished suffix. Complete malformed or noncontiguous
  records are permanent errors. `setCursorAtomic` replaces a validated,
  absolute-bound cursor through a same-directory atomic rename. `resetDeltaLog`
  deletes a log's manifest and data file, returns its removed and missing paths,
  and is idempotent against an already-clean (never-appended) log.
- `snapshotPath` is deterministic and scoped by repo, monitor-id, and entity set;
  `economicalSnapshotPath` derives the independent bounded-watch sibling.
- `horizonCutoff` derives the incremental-fetch cutoff from a prior snapshot
  (`meta.horizon` minus the optional `overlapMs`, which defaults to `0`); a `null` snapshot yields `null`
  (open-items-only fetch). Broad `fetchPRs` and `fetchIssues` calls may supply
  `onServerTime(isoTimestamp)` to capture the HTTP `Date` header from their first
  open-page response. Without that callback, their response and request shapes
  remain unchanged.
- `prFingerprint`/`issueFingerprint` build the compared subset directly from an
  already-normalized PR/issue row (see [Fingerprint fields](fingerprints.md#fingerprint-fields-from--to)
  for the exact shape `lib/gh.mjs` normalizes into); there is no drop-list —
  every key on the returned object participates in the comparison and the
  delta id.
- `stableValue` recursively key-sorts an object so GitHub's field ordering never
  changes a fingerprint hash or a delta `id`.
- `deltaIdentity` builds the `{ repo, entity, number, to }` (or, when `to` is
  `null`, `{ repo, entity, number, from, classes, missingTicks }`) object that
  `deltaId` hashes into the content-addressed `id` on every delta.
- `deltaId` returns the full 64-character sha256 hex of a canonicalized delta
  identity; pair it with `deltaIdentity` at the report-assembly layer.
- `defaultMonitorId` derives the zero-config `--monitor-id` default (`host-` +
  the first 12 hex characters of the sha1 of hostname plus the Git worktree
  toplevel, or resolved cwd outside Git).
- `REGISTRY_VERSION` is the integer schema version stamped into every
  run-registry breadcrumb file.
- `acquireLock`/`releaseLock`/`assertLockOwned` implement the state-file lock
  described in [Lock Semantics](locks.md#lock-semantics); a library caller embedding
  the detector directly (rather than through the CLI) is responsible for
  calling them around its own read-fetch-write cycle if it wants the same
  one-writer-per-state-file guarantee `gh-delta` enforces at the CLI layer.
- `runBoundedWait` owns the bounded sleep/heartbeat/signal loop behind the
  `wait` subcommand. Its injected `tick` boundary is intentionally lock-free
  between calls; callers provide one complete lock-scoped operation per tick.
- `threadReplyIncrements(oldThreads, newThreads)` names, for each thread
  present on both sides, how many new comments it gained
  (`{id, increment, total}`); a thread with no prior baseline (opened this
  tick) is silently excluded, since there is nothing to diff it against.
- `parseActionsRunJob(url)` extracts `{runId, jobId}` from a GitHub Actions
  run/job details URL, or `null` for any other host, unparseable URL, or
  non-matching path -- a `null` fingerprints identically to a check with no
  URL at all, so an unparsed row never churns a delta id on its own.
- `extendLockDeadline(stateFile, token, opts)` pushes a held lock's
  `expiresAt` forward after a unit of progress; a no-op (`{ok: false}`, never
  a throw) if the on-disk token does not match `token` -- it never writes on
  behalf of a lock it does not own.
- `defaultMachineId({hostname})` derives the per-machine id
  (`host-<12-hex-chars>`) stamped into every run-registry breadcrumb's
  `machineId` field.
- `parseIgnoreAuthors(raw)`/`parseEnrichmentSelection(raw)` parse
  `--ignore-authors`/`--enrich`'s comma-separated flag grammars into a
  validated `{ok, ...}` selection, the same parse the CLI itself uses.
- `defaultStateDirInspection(path)` reports `{exists, writable}` for a
  candidate state directory, without creating or modifying anything.

The exit code is the primary machine signal. Branch on it before reading stdout:
codes `1` and `2` produce an [error report](errors.md#error-report-shape) with no
`deltas` field.
