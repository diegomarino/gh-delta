// CLI orchestration seam. Chains the pure and boundary modules into one tick:
// args -> snapshot read -> GitHub fetch -> delta detection -> snapshot write ->
// optional outpost delivery -> report. Keeps every side effect at this layer so
// detect/fingerprint stay pure and independently testable.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  readFileSync,
  utimesSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import {
  fetchPRs as ghPRs,
  fetchPRsByNumber as ghPRsByNumber,
  fetchIssues as ghIssues,
  fetchEnrichment as ghEnrichment,
  fetchThreadReplies as ghThreadReplies,
  fetchRateLimit as ghRateLimit,
} from './gh.mjs';
import { detectDeltas, threadSetDiff, threadReplyIncrements } from './detect.mjs';
import { deltaId, deltaIdentity } from './fingerprint.mjs';
import { deltaSummary } from './summary.mjs';
import { diffFingerprint } from './diff.mjs';
import {
  defaultStateDir,
  horizonCutoff,
  economicalSnapshotPath,
  readSnapshot as fsRead,
  snapshotPath,
  SNAPSHOT_SCHEMA_VERSION,
  writeSnapshotAtomic as fsWrite,
} from './snapshot.mjs';
import {
  acquireLock as fsAcquireLock,
  assertLockOwned as fsAssertLockOwned,
  extendLockDeadline as fsExtendLockDeadline,
  releaseLock as fsReleaseLock,
} from './lock.mjs';
import { sendOutposts, validateOutpostUrl } from './outpost.mjs';
import { listMonitors as fsListMonitors, parseSince } from './list.mjs';
import {
  defaultMachineId,
  defaultRegistryDir,
  readRegistry as fsReadRegistry,
  registerMonitor as fsRegisterMonitor,
} from './registry.mjs';
import {
  defaultMonitorId,
  parseEntitySelection,
  parseIgnoreAuthors,
  parseEnrichmentSelection,
  validateMonitorId,
  validateRepo,
} from './args.mjs';
import { enrichEmittedDeltas } from './enrich.mjs';
import { parseDuration } from './duration.mjs';
import {
  addWatch,
  listWatch,
  markTerminalIgnored,
  readWatch,
  removeWatch,
  removeWatchUnchanged,
  watchFilename,
  watchDirPath,
} from './watch.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import {
  formatCompactTextOutput,
  formatCursorSetTextOutput,
  formatDemoTextOutput,
  formatDoctorTextOutput,
  formatExplainTextOutput,
  formatInitTextOutput,
  formatListTextOutput,
  formatStatusTextOutput,
  formatWatchTextOutput,
  formatOutpostWarnings,
  formatReadTextOutput,
  formatResetTextOutput,
  formatTextOutput,
} from './text-output.mjs';
import { getPackageMetadata, renderVersionText } from './version.mjs';
import { applyConfig } from './config.mjs';
import {
  defaultStateDirInspection,
  explainDelta,
  initializeMonitor,
  runDoctorChecks,
  writeConfigDurableNoOverwrite,
} from './dx.mjs';
import {
  DELTA_CLASSES,
  DELTA_SUMMARY_ENUMS,
  DELTA_SUMMARY_FIELDS,
  REPORT_SCHEMA_VERSION,
} from './contract.mjs';
import { compactReport, ndjsonReport } from './compact-output.mjs';
import { schemaFor } from './schema.mjs';
import { runBoundedWait } from './wait.mjs';
import { resolveRepoFromGit, resolveRepoFromLocalGit } from './repo-source.mjs';
import {
  appendDeltaLog as fsAppendDeltaLog,
  compactDeltaLog as fsCompactDeltaLog,
  deltaLogPath,
  readCursor as fsReadCursor,
  readDeltaLog as fsReadDeltaLog,
  resetDeltaLog as fsResetDeltaLog,
  setCursorAtomic as fsSetCursorAtomic,
} from './deltalog.mjs';

// Version of the machine-readable detector report shape. Bumped only on a
// breaking change (a field removed or renamed). Additive fields -- new optional
// keys on the report, a delta, or a fingerprint -- do not bump it. Consumers can
// assert `report.schemaVersion === 2` on every JSON response, success or error.
export { REPORT_SCHEMA_VERSION };

// Cursor scans are local, synchronous filesystem work. These fixed leases are
// intentionally independent of GitHub's fetch timeout and are renewed once
// after a scan, immediately before a cursor replacement.
const CURSOR_LOCK_TIMEOUT_MS = 5000;
const CURSOR_LOCK_STALE_MS = 30000;

function cursorLockOptions(cursorLockFs, cursorLockNow) {
  return {
    ghTimeoutMs: CURSOR_LOCK_TIMEOUT_MS,
    staleMs: CURSOR_LOCK_STALE_MS,
    ...(cursorLockFs ? { fs: cursorLockFs } : {}),
    now: cursorLockNow,
  };
}

/**
 * Build a compact human-readable summary line for a single delta.
 */
function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.context?.title}": ${d.classes.join(', ')}`;
}

function hasField(value, field) {
  return value != null && Object.hasOwn(value, field);
}

// Snapshot items store `{ fingerprint, context, meta }` (see lib/snapshot.mjs);
// every detail-row helper below explains a *fingerprint* transition, so they
// all read through this accessor rather than the item itself.
function fpOf(item) {
  return item?.fingerprint;
}

function fieldDetail(klass, field, from, to, extra = {}) {
  return Object.fromEntries(
    Object.entries({ class: klass, field, from, to, ...extra }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function pushFieldDetail(details, klass, delta, field, extra = {}) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  if (!hasField(from, field) && !hasField(to, field)) return;
  const fromValue = hasField(from, field) ? from[field] : null;
  const toValue = hasField(to, field) ? to[field] : null;
  if (JSON.stringify(fromValue) === JSON.stringify(toValue)) return;
  details.push(fieldDetail(klass, field, fromValue, toValue, extra));
}

// `reviewThreads`/`unresolvedReviewThreads` are not stored fingerprint fields
// in schema v2 (R2 dropped the separate counters in favor of the single
// `threads[]` array); they are derived on demand from `threads[]`, the array
// that actually enters the delta id.
function derivedField(fp, field) {
  if (field === 'reviewThreads') return Array.isArray(fp?.threads) ? fp.threads.length : undefined;
  if (field === 'unresolvedReviewThreads')
    return Array.isArray(fp?.threads) ? fp.threads.filter((t) => !t?.resolved).length : undefined;
  return hasField(fp, field) ? fp[field] : undefined;
}

function pushNumericDelta(details, klass, delta, field) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  const fromValue = derivedField(from, field);
  const toValue = derivedField(to, field);
  if (fromValue === undefined || toValue === undefined) return;
  if (fromValue === toValue) return;
  const extra = { delta: toValue - fromValue };
  if (klass === 'new-comments') {
    const added = to?.recentComments;
    const conversationIncrement =
      (to?.conversationComments ?? NaN) - (from?.conversationComments ?? NaN);
    if (
      conversationIncrement === extra.delta &&
      Array.isArray(added) &&
      extra.delta > 0 &&
      extra.delta <= added.length
    ) {
      const rows = added.slice(-extra.delta);
      if (rows.every((row) => row?.id && row?.author)) extra.added = rows;
      else extra.opaque = true;
    } else extra.opaque = true;
  }
  details.push(fieldDetail(klass, field, fromValue, toValue, extra));
}

// Set-style detail for sorted string-list fingerprint fields (labels,
// assignees, reviewRequests): name what entered and what left.
function pushSetDelta(details, klass, delta, field) {
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);
  const from = hasField(fromFp, field) ? fromFp[field] : [];
  const to = hasField(toFp, field) ? toFp[field] : [];
  const oldEntries = new Set(from);
  const newEntries = new Set(to);
  details.push({
    class: klass,
    field,
    added: to.filter((entry) => !oldEntries.has(entry)),
    removed: from.filter((entry) => !newEntries.has(entry)),
  });
}

// Set-style detail naming the review-thread ids that newly became unresolved
// or resolved, for the `unresolved-threads-added`/`-resolved` classes. This is
// what lets `--detail` name a same-count swap (P2-1): the counters alone are
// unchanged in that case, so `pushNumericDelta` returns nothing, and this is
// the only detail row that names the affected threads. Omitted entirely when
// there is nothing to name (a class that fired purely from the counter moving
// with no identity-level swap).
function pushThreadSetDelta(details, klass, delta) {
  const { addedIds, removedIds } = threadSetDiff(
    fpOf(delta.from)?.threads,
    fpOf(delta.to)?.threads,
  );
  if (addedIds.length === 0 && removedIds.length === 0) return;
  details.push({ class: klass, field: 'threads', added: addedIds, removed: removedIds });
}

function changedFingerprintFields(delta) {
  const from = fpOf(delta.from);
  const to = fpOf(delta.to);
  if (!from || !to) return [];
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...keys]
    .filter(
      (key) =>
        // checks/reviews/threads each already drive a dedicated class detail
        // (ci-changed's named breakdown, review-changed's named breakdown,
        // unresolved-threads-added/-resolved's threads row) whenever they are
        // the reason a delta fired, so `updated` (the catch-all for when
        // nothing else classified) never needs to duplicate them here.
        // recentComments is a bounded rolling window (see prFingerprint):
        // its contents can rotate (an old comment drops off, a new one
        // enters) with the comment count unchanged, which is not itself
        // actionable -- any real count change is already captured by
        // conversationComments/reviewComments, which ARE declared. Reporting
        // recentComments here would also require declaring it in
        // DELTA_DETAIL_FIELDS_BY_CLASS.updated; excluding it keeps that
        // catalog matching what `updated` can actually emit.
        !['checks', 'reviews', 'threads', 'recentComments'].includes(key),
    )
    .filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
    .sort();
}

// Diff two normalized summary arrays keyed by one field (check `name` or review
// `author`), yielding the added/removed entries and per-key from/to transitions.
// Returns null when either side repeats a key (e.g. a CheckRun and a
// StatusContext sharing one name): the maps would silently collapse the
// duplicates and misreport the breakdown, so the caller must fall back to opaque.
function diffSummaries(from, to, key) {
  const fromByKey = new Map(from.map((entry) => [entry[key], entry]));
  const toByKey = new Map(to.map((entry) => [entry[key], entry]));
  if (fromByKey.size !== from.length || toByKey.size !== to.length) return null;
  const changed = [];
  for (const [k, fromEntry] of fromByKey) {
    const toEntry = toByKey.get(k);
    if (!toEntry || JSON.stringify(fromEntry) === JSON.stringify(toEntry)) continue;
    const { [key]: _from, ...fromRest } = fromEntry;
    const { [key]: _to, ...toRest } = toEntry;
    changed.push({ [key]: k, from: fromRest, to: toRest });
  }
  return {
    added: to.filter((entry) => !fromByKey.has(entry[key])),
    removed: from.filter((entry) => !toByKey.has(entry[key])),
    changed,
  };
}

// Build the extra detail keys for a checks/reviews array transition. Names the
// exact entries that changed so an agent can act without re-querying GitHub.
// Falls back to marking the transition `opaque: true` when duplicate keys (a
// CheckRun and a StatusContext sharing one name) make the breakdown unsafe to
// report, or there is nothing to name.
function summaryDiffExtra(delta, field, key) {
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);
  const from = fromFp?.[field];
  const to = toFp?.[field];
  if (!Array.isArray(from) || !Array.isArray(to)) return { opaque: true };
  const diff = diffSummaries(from, to, key);
  if (!diff || (!diff.added.length && !diff.removed.length && !diff.changed.length)) {
    return { opaque: true };
  }
  return diff;
}

// Expand one delta class into the schema's field-level `details` entries: the
// concrete from/to changes (state, labels, checks, presence, ...) a consumer
// needs to act without re-diffing the raw fingerprints. Each class maps to
// the fields it can meaningfully explain; checks/reviews transitions carry a
// named added/removed/changed breakdown when both sides' raw fingerprint
// arrays are comparable, and are marked `opaque: true` when they cannot name
// the change.
function detailForClass(delta, klass) {
  const details = [];
  switch (klass) {
    case 'new':
    case 'first-seen':
    case 'baseline-state':
      details.push({ class: klass, field: 'presence', from: null, to: 'present' });
      pushFieldDetail(details, klass, delta, 'state');
      break;
    case 'missing':
    case 'still-missing':
    case 'presumed-deleted':
      details.push(
        fieldDetail(klass, 'presence', 'present', 'missing', {
          missingTicks:
            delta.missingTicks ??
            delta.from?.meta?.missingTicks ??
            (klass === 'missing' ? 1 : undefined),
        }),
      );
      break;
    case 'reappeared':
      details.push(
        fieldDetail(klass, 'presence', 'missing', 'present', {
          missingTicks: delta.from?.meta?.missingTicks,
        }),
      );
      break;
    case 'closed':
    case 'reopened':
    case 'merged':
      pushFieldDetail(details, klass, delta, 'state');
      break;
    case 'draft-ready':
    case 'converted-to-draft':
      pushFieldDetail(details, klass, delta, 'isDraft');
      break;
    case 'ci-changed':
      pushFieldDetail(details, klass, delta, 'checks', summaryDiffExtra(delta, 'checks', 'name'));
      break;
    case 'review-changed':
      pushFieldDetail(details, klass, delta, 'reviewDecision');
      pushFieldDetail(details, klass, delta, 'reviews', summaryDiffExtra(delta, 'reviews', 'id'));
      break;
    case 'became-mergeable':
    case 'became-conflicting':
      pushFieldDetail(details, klass, delta, 'mergeable');
      break;
    case 'base-changed':
      pushFieldDetail(details, klass, delta, 'baseRef');
      break;
    case 'head-changed':
      pushFieldDetail(details, klass, delta, 'headSha');
      break;
    case 'stale':
      details.push({ class: klass, field: 'staleAt', from: null, to: delta.staleAt });
      break;
    case 'new-comments':
    case 'comments-removed':
      pushNumericDelta(details, klass, delta, 'conversationComments');
      break;
    case 'review-comments-added':
    case 'review-comments-removed':
      pushNumericDelta(details, klass, delta, 'reviewComments');
      break;
    case 'unresolved-threads-added':
    case 'unresolved-threads-resolved':
      pushNumericDelta(details, klass, delta, 'unresolvedReviewThreads');
      pushThreadSetDelta(details, klass, delta);
      break;
    case 'review-threads-changed':
      pushNumericDelta(details, klass, delta, 'reviewThreads');
      break;
    case 'relabeled':
      pushSetDelta(details, klass, delta, 'labels');
      break;
    case 'assignees-changed':
      pushSetDelta(details, klass, delta, 'assignees');
      break;
    case 'review-requests-changed':
      pushSetDelta(details, klass, delta, 'reviewRequests');
      break;
    case 'updated':
      for (const field of changedFingerprintFields(delta)) {
        const extra =
          field === 'checks'
            ? summaryDiffExtra(delta, 'checks', 'name')
            : field === 'reviews'
              ? summaryDiffExtra(delta, 'reviews', 'id')
              : {};
        pushFieldDetail(details, klass, delta, field, extra);
      }
      break;
    default:
      details.push({ class: klass, field: 'unknown', note: 'unrecognized class' });
      break;
  }
  return details;
}

function detailDelta(delta) {
  return delta.classes.flatMap((klass) => detailForClass(delta, klass));
}

// Exported so docs tooling (tools/examples) can render fixture deltas through
// the exact same enrichment the CLI uses, keeping example artifacts faithful.
export function enrichDelta(delta, { summaryLine = false, details = false } = {}) {
  if (summaryLine) delta.summaryLine = line(delta);
  if (details) delta.details = detailDelta(delta);
  // `changed`/`summary` are always-on schema v2 fields (siblings of `to`,
  // never nested inside it, so the content-addressed delta.id -- which hashes
  // `to` -- stays unaffected). `summary` is null for the missing lifecycle
  // (no observed `to` state); every other delta gets one, PR or issue.
  delta.changed = diffFingerprint(delta.from?.fingerprint, delta.to?.fingerprint);
  delta.summary = deltaSummary(delta);
}

// Permanent errors exit 2; transient errors exit 1. `busy` (state-file lock
// held or unresolvable) is transient: the next tick retries.
const ERROR_EXIT_CODES = {
  config: 2,
  snapshot: 2,
  github: 1,
  io: 1,
  busy: 1,
  log: 2,
  'rate-limit': 1,
};

// GH_DELTA_NO_REGISTRY disables the run-registry breadcrumb, but only for
// values that actually mean "on". An explicit `0`, `false`, or empty string is
// treated as unset so a wrapper exporting GH_DELTA_NO_REGISTRY=0 to mean
// "registry ON" is not silently opted out. Every doc writes the opt-out as `=1`.
const REGISTRY_ENV_OFF = new Set(['', '0', 'false']);
function envDisablesRegistry(value) {
  return value !== undefined && !REGISTRY_ENV_OFF.has(String(value).trim().toLowerCase());
}

function selectedMonitorId(values, env, makeDefault) {
  return values['monitor-id'] ?? env.GH_DELTA_MONITOR_ID ?? makeDefault();
}

// Keep injected command-input readers (for example explain's report file) from
// accidentally impersonating the configuration filesystem. Tests and embedders
// can inject `configReadFileSync` explicitly; production uses the normal fs.
function configDeps(deps) {
  return { ...deps, readFileSync: deps.configReadFileSync ?? readFileSync };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/["\\\\]/g, '\\\\$&')}"`;
}

function agentCommand(repo, monitorId, entities, stateDir) {
  return [
    'gh-delta',
    '--repo',
    repo,
    '--monitor-id',
    monitorId,
    '--entities',
    entities,
    '--state-dir',
    stateDir,
  ];
}

function errorHint(kind, error) {
  const message = String(error ?? '').toLowerCase();
  if (kind === 'github' && (message.includes('scope') || message.includes('organization')))
    return 'Token may lack read:org; run gh auth refresh -s read:org, then gh-delta doctor.';
  if (kind === 'github')
    return 'Check gh authentication and connectivity with gh-delta doctor, then retry.';
  if (kind === 'rate-limit')
    return 'Wait until resetAt, lower --rate-limit-floor, or inspect quota with gh-delta doctor.';
  if (kind === 'busy')
    return 'Another monitor owns this state file; wait for it to finish or use a distinct --monitor-id.';
  if (kind === 'snapshot')
    return 'Inspect the state file; restore valid JSON, choose a new durable --state-dir, or run `gh-delta reset` to start a clean baseline.';
  if (kind === 'log')
    return 'Inspect the durable delta log and cursor before retrying (do not truncate it automatically); a cursor pointing past the tail or a pre-schema-v2 log is fixed by deleting the cursor and/or running `gh-delta reset` to start a clean baseline.';
  if (kind === 'io')
    return 'Check the state directory exists and is writable, then run gh-delta doctor.';
  return 'Fix the command configuration, or run gh-delta doctor for a local diagnostic.';
}

// Build a structured error result with kind, exit code, and report.
// context holds optional { repo, monitorId, at } fields.
function errorResult(kind, error, context, format) {
  return {
    code: ERROR_EXIT_CODES[kind],
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      error,
      kind,
      hint: errorHint(kind, error),
      ...context,
    },
    format,
  };
}

/**
 * Validate and parse a positive integer from a string.
 *
 * @param {string} name - The flag name for error messages
 * @param {string} raw - The raw string value
 * @returns {{ value: number } | { error: string }}
 */
function positiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    return { error: `${name} must be a positive integer; got "${raw}"` };
  return { value };
}

function nonNegativeSafeInt(name, raw) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw))
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  return { value };
}

function parseDeltaClassSelection(flag, raw) {
  if (raw === undefined) return { ok: true, classes: [] };
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const invalid = tokens.find((token) => !DELTA_CLASSES.includes(token));
  if (invalid) return { ok: false, error: `${flag} must name a delta class; got "${invalid}"` };
  if (tokens.length === 0)
    return { ok: false, error: `${flag} must name at least one delta class; got "${raw}"` };
  return { ok: true, classes: [...new Set(tokens)] };
}

const TERMINAL_STATES = new Set(['merged', 'closed']);

// Would the CURRENT invocation's --ignore-classes/--only-classes suppress
// `terminalClass` if it appeared on a delta right now? This is the one
// question with a stable, replay-independent answer -- unlike
// --ignore-authors/--settled, which depend on the actual delta content each
// tick and so cannot be "still active" in the same reusable sense (see
// isTerminalCleanupEligible's doc comment for the resulting, deliberately
// narrower scope of what this can protect).
function terminalClassFilteredByFlags(terminalClass, { onlyClasses, ignoreClasses }) {
  return (
    ignoreClasses.includes(terminalClass) ||
    (onlyClasses.length > 0 && !onlyClasses.includes(terminalClass))
  );
}

/**
 * Decide whether a delta may trigger `--until` watch-directory cleanup this
 * tick. Marking a watch entry as having had a terminal transition ignored
 * is a SEPARATE concern, handled entirely by
 * watchedTerminalTransitionFilteredThisTick below -- see its doc comment
 * for why that must run before attention filtering, and why doing it there
 * already covers every case a check here could (a delta present in `deltas`
 * with the terminal class stripped is a strict subset of "the current
 * filters would suppress that class by name", which the earlier check
 * already tests unconditionally, independent of what else survives on the
 * same delta). Five rounds on this predicate; four cases now:
 *
 *   1. First observation (`delta.from` is null: the `new`/`first-seen`/
 *      `baseline-state` classes -- see lib/detect.mjs's diffEntity, which
 *      never combines any of them with `merged`/`closed`). Always eligible
 *      -- there is no transition tick here for any filter to have meant
 *      "ignore this" about; the item was simply already terminal (or not)
 *      the very first time we ever saw it.
 *   2. A genuine transition this tick (`delta.from.state` was open,
 *      `to.state` is now terminal). classifyPr/classifyIssue attach the
 *      matching `merged`/`closed` class if and only if this happens, so
 *      eligibility is exactly "did that class survive filtering."
 *   3. No transition this tick, no recorded mark (`delta.from.state` was
 *      ALREADY terminal, and the watch entry has never recorded an ignored
 *      transition). Always eligible -- this is the broad-poll case: the
 *      item was terminal before it was ever watched, or its one transition
 *      was never actually filtered, so there is nothing here for any
 *      filter to have meant "ignore" about.
 *   4. No transition this tick, WITH a recorded mark. Eligible only once
 *      the CURRENT invocation's filters no longer target the recorded
 *      terminal class -- "removable as soon as the operator stops ignoring
 *      it" is the deliberate semantic (see lib/watch.mjs's
 *      markTerminalIgnored doc comment).
 */
function isTerminalCleanupEligible(delta, watchedEntry, filters) {
  const state = delta.to?.state;
  const terminalClass = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : null;
  if (terminalClass === null) return false;
  const priorState = delta.from?.state ?? null;
  if (priorState === null) return true;
  if (!TERMINAL_STATES.has(priorState)) return delta.classes.includes(terminalClass);
  if (watchedEntry?.ignoredTerminalAt === undefined) return true;
  return !terminalClassFilteredByFlags(terminalClass, filters);
}

// Detects case 2 above -- a genuine transition into a terminal state --
// whose matching class the CURRENT invocation's filters would suppress,
// evaluated BEFORE attention filtering has run, against the snapshot-item
// shape (`delta.from`/`delta.to` are still `{fingerprint, context, meta}`
// here, not yet stripped to bare fingerprints -- see the stripping loop
// later in run()). This must run before filtering because it is the only
// way to catch a transition whose delta gets dropped ENTIRELY (e.g. a pure
// `merged` delta with no other surviving class): once that happens, the
// post-filter `deltas` the main cleanup loop iterates never contains it at
// all, so nothing later could ever recover the fact that a filtered
// transition occurred -- attention filtering runs before both the report
// and the durable log, so this moment is the only trace of it that will
// ever exist.
function watchedTerminalTransitionFilteredThisTick(delta, watched, filters) {
  if (!watched || watched.entry.ignoredTerminalAt !== undefined) return false;
  const priorState = delta.from?.fingerprint?.state ?? null;
  if (priorState === null || TERMINAL_STATES.has(priorState)) return false;
  const state = delta.to?.fingerprint?.state;
  const terminalClass = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : null;
  return terminalClass !== null && terminalClassFilteredByFlags(terminalClass, filters);
}

// Attention filters are deliberately applied after detection. They may change
// the emitted report, but never the complete observation used for the snapshot.
function applyAttentionFilters(deltas, { onlyClasses, ignoreClasses, settled }) {
  const only = new Set(onlyClasses);
  const ignored = new Set(ignoreClasses);
  const survivors = [];
  let filteredDeltas = 0;

  for (const delta of deltas) {
    if (only.size > 0 && !delta.classes.some((klass) => only.has(klass))) {
      filteredDeltas++;
      continue;
    }
    const classes = delta.classes.filter((klass) => !ignored.has(klass));
    if (classes.length === 0) {
      filteredDeltas++;
      continue;
    }
    const filtered = classes.length === delta.classes.length ? delta : { ...delta, classes };
    if (
      settled &&
      (filtered.summary?.ciRollup === 'pending' || filtered.summary?.mergeable === 'unknown')
    ) {
      filteredDeltas++;
      continue;
    }
    survivors.push(filtered);
  }
  return { deltas: survivors, filteredDeltas };
}

// Attribute the reviews that changed between `from` and `to` (added ids, or
// an id whose row differs) -- the set --ignore-authors checks for
// review-changed. Returns [] when nothing is attributable (e.g. reviewDecision
// moved with no reviews[] row diff), which the caller treats as "cannot
// verify, fail open."
function changedOrNewReviews(fromFp, toFp) {
  if (!Array.isArray(toFp?.reviews)) return [];
  const oldById = new Map(
    (Array.isArray(fromFp?.reviews) ? fromFp.reviews : [])
      .filter((row) => row?.id)
      .map((row) => [row.id, JSON.stringify(row)]),
  );
  return toFp.reviews.filter((row) => row?.id && oldById.get(row.id) !== JSON.stringify(row));
}

// classifyPr fires review-changed on EITHER a reviewDecision move OR a
// reviews[] row diff (lib/detect.mjs). changedOrNewReviews above only ever
// names the row-level diff. If reviewDecision itself moved -- e.g. an admin
// dismissal or a branch-protection recompute with no reviews[] row change,
// or a tick where reviewDecision moved AND an unrelated ignored-author row
// also changed -- attributing the whole class to just the changed rows'
// authors would risk suppressing a reviewDecision transition a human needs
// to see for a reason the changed rows don't actually explain. Fail open
// (never suppress review-changed) whenever reviewDecision itself moved;
// only attempt suppression when reviewDecision is unchanged and every
// review row that differs belongs to an ignored author.
function reviewDecisionMoved(fromFp, toFp) {
  return (fromFp?.reviewDecision ?? 'none') !== (toFp?.reviewDecision ?? 'none');
}

function allAuthorsIgnored(authors, ignoredAuthors) {
  return (
    authors.length > 0 &&
    authors.every(
      (author) => typeof author === 'string' && ignoredAuthors.includes(author.toLowerCase()),
    )
  );
}

// Rewrite of the pre-schema-v2 commentAuthorsIgnored: that function made no
// network call, inspected only the last-5 conversation comment nodes, and
// handled only the new-comments class against the now-deleted aggregate
// `comments` counter. This covers all three --ignore-authors sources:
// conversation comments (unchanged behavior, renamed field), reviews
// (reviews[].author, no fetch needed -- already in the fingerprint), and
// thread replies (review-comments-added, needs threadReplyRows -- see the
// pre-publish pass in run() below; absent/undefined here means "not
// available," which fails open and is reported by the caller as an explicit
// warning, never silently).
function authorsIgnored(delta, ignoredAuthors, { threadReplyRows } = {}) {
  if (!ignoredAuthors?.length) return { delta, filtered: false };
  let classes = delta.classes;
  const fromFp = fpOf(delta.from);
  const toFp = fpOf(delta.to);

  if (classes.includes('new-comments')) {
    const increment = (toFp?.conversationComments ?? NaN) - (fromFp?.conversationComments ?? NaN);
    const rows = toFp?.recentComments;
    if (
      increment > 0 &&
      Array.isArray(rows) &&
      increment <= rows.length &&
      rows.slice(-increment).every((row) => row?.id && row?.author) &&
      allAuthorsIgnored(
        rows.slice(-increment).map((row) => row.author),
        ignoredAuthors,
      )
    ) {
      classes = classes.filter((klass) => klass !== 'new-comments');
    }
  }

  if (classes.includes('review-changed') && !reviewDecisionMoved(fromFp, toFp)) {
    const changed = changedOrNewReviews(fromFp, toFp);
    if (
      allAuthorsIgnored(
        changed.map((row) => row.author),
        ignoredAuthors,
      )
    ) {
      classes = classes.filter((klass) => klass !== 'review-changed');
    }
  }

  if (classes.includes('review-comments-added')) {
    const rows = threadReplyRows?.get(delta.id);
    if (rows) {
      const authors = rows.flatMap((thread) => thread.replies.map((reply) => reply.author));
      if (allAuthorsIgnored(authors, ignoredAuthors)) {
        classes = classes.filter((klass) => klass !== 'review-comments-added');
      }
    }
  }

  if (classes.length === delta.classes.length) return { delta, filtered: false };
  return { delta: classes.length ? { ...delta, classes } : null, filtered: true };
}

const CLI_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  number: { type: 'string' },
  format: { type: 'string', default: 'json' },
  detail: { type: 'boolean', default: false },
  summaries: { type: 'boolean', default: false },
  enrich: { type: 'string' },
  'rate-limit-floor': { type: 'string' },
  'only-classes': { type: 'string' },
  'ignore-classes': { type: 'string' },
  'ignore-authors': { type: 'string' },
  settled: { type: 'boolean', default: false },
  'baseline-emit-state': { type: 'boolean', default: false },
  'summary-line': { type: 'boolean', default: false },
  full: { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
  'outpost-secret': { type: 'string' },
  'outpost-timeout-ms': { type: 'string', default: '4000' },
  'outpost-max-posts': { type: 'string' },
  'gh-timeout-ms': { type: 'string', default: '60000' },
  'no-registry': { type: 'boolean', default: false },
  'lock-stale-ms': { type: 'string', default: '10m' },
  'stale-after': { type: 'string' },
  log: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const READ_OPTIONS = {
  cursor: { type: 'string' },
  'only-classes': { type: 'string' },
  number: { type: 'string' },
  advance: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const CURSOR_SET_OPTIONS = {
  'log-file': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const COMPACT_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  keep: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const RESET_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  yes: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

// Idempotent: deleting an already-absent snapshot is not an error.
function fsDeleteSnapshot(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
const SCHEMA_OPTIONS = {
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const STATUS_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  number: { type: 'string' },
  refresh: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const INIT_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  agent: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const DOCTOR_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const EXPLAIN_OPTIONS = {
  'log-file': { type: 'string' },
  'report-file': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const DEMO_OPTIONS = {
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const {
  'outpost-url': _waitOutpostUrl,
  'outpost-secret': _waitOutpostSecret,
  'outpost-timeout-ms': _waitOutpostTimeout,
  'outpost-max-posts': _waitOutpostMaxPosts,
  ...WAIT_DETECTOR_OPTIONS
} = CLI_OPTIONS;
const WAIT_OPTIONS = {
  ...WAIT_DETECTOR_OPTIONS,
  timeout: { type: 'string' },
  until: { type: 'string' },
  'until-summary': { type: 'string' },
  interval: { type: 'string', default: '60s' },
  'max-interval': { type: 'string' },
  backoff: { type: 'string', default: '1' },
  settle: { type: 'string' },
  'heartbeat-file': { type: 'string' },
  progress: { type: 'boolean', default: false },
  'from-log': { type: 'boolean', default: false },
  cursor: { type: 'string' },
};

// Help must be indestructible: an agent probing with --help-json gets the help
// document even when the rest of the command is invalid. Literal pre-scan, no parsing.
function helpRequest(argv) {
  if (argv.includes('--help')) return renderHelpText('gh-delta');
  if (argv.includes('--help-json')) return renderHelpJson('gh-delta');
  if (argv.includes('--version')) return renderVersionText();
  return null;
}

// Tolerant --format sniff used ONLY to render errors when strict parsing failed.
function formatSniff(argv) {
  let format = 'json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format' && argv[i + 1]) format = argv[i + 1];
    else if (argv[i].startsWith('--format=')) format = argv[i].slice('--format='.length);
  }
  return ['text', 'compact', 'ndjson'].includes(format) ? format : 'json';
}

/**
 * One strict parse for the whole CLI. Repeated flags: last value wins.
 *
 * Returns `{ help }` when a help/version flag is detected (pre-scan, no parse),
 * `{ error, format }` on a parse failure, or `{ values, format }` on success.
 *
 * @param {string[]} argv
 * @returns {{ help?: string, error?: string, values?: object, format: string }}
 */
export function parseCli(argv) {
  const help = helpRequest(argv);
  if (help) return { help, format: 'json' };
  try {
    const { values } = parseArgs({ args: argv, options: CLI_OPTIONS });
    return { values, format: values.format };
  } catch (err) {
    return { error: String(err?.message ?? err), format: formatSniff(argv) };
  }
}

const LIST_OPTIONS = {
  'state-dir': { type: 'string' },
  since: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};
const WATCH_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  until: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

// Command-scoped map from a help-spec command key (see HELP_SPECS in
// help.mjs) to the parser option table that backs it. Deliberately NOT a
// flat set of all flags across the whole CLI: once subcommands multiply
// (wait, read, status, watch, schema, ...) a flat comparison stops meaning
// anything, since two subcommands are free to define the same flag name
// with different semantics or not define it at all. Every new subcommand
// MUST add its own entry here alongside its HELP_SPECS entry — this map,
// together with the sync test in test/help-options-sync.test.mjs, is what
// enforces that the parser and --help never drift apart per command.
export const PARSER_OPTIONS_BY_COMMAND = Object.freeze({
  'gh-delta': CLI_OPTIONS,
  'gh-delta list': LIST_OPTIONS,
  'gh-delta watch add': WATCH_OPTIONS,
  'gh-delta watch rm': Object.fromEntries(
    Object.entries(WATCH_OPTIONS).filter(([name]) => name !== 'until'),
  ),
  'gh-delta watch ls': Object.fromEntries(
    Object.entries(WATCH_OPTIONS).filter(([name]) => name !== 'until'),
  ),
  'gh-delta read': READ_OPTIONS,
  'gh-delta cursor set': CURSOR_SET_OPTIONS,
  'gh-delta log compact': COMPACT_OPTIONS,
  'gh-delta reset': RESET_OPTIONS,
  'gh-delta schema': SCHEMA_OPTIONS,
  'gh-delta status': STATUS_OPTIONS,
  'gh-delta wait': WAIT_OPTIONS,
  'gh-delta init': INIT_OPTIONS,
  'gh-delta doctor': DOCTOR_OPTIONS,
  'gh-delta explain': EXPLAIN_OPTIONS,
  'gh-delta demo': DEMO_OPTIONS,
});

function watchNumbers(raw) {
  if (raw === undefined) return { ok: true, numbers: null };
  const values = String(raw)
    .split(',')
    .map((x) => Number(x.trim()));
  return values.length && values.every((n) => Number.isSafeInteger(n) && n > 0)
    ? { ok: true, numbers: new Set(values) }
    : { ok: false, error: '--number must be comma-separated positive safe integers' };
}
function runWatch(argv, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const action = argv.shift();
  if (!['add', 'rm', 'ls'].includes(action))
    return errorResult(
      'config',
      'watch requires add, rm, or ls',
      { at, command: 'watch' },
      formatSniff(argv),
    );
  const help = commandHelp(argv, `gh-delta watch ${action}`);
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    const parsed = parseArgs({ args: argv, options: WATCH_OPTIONS, allowPositionals: true });
    values = { ...parsed.values, positionals: parsed.positionals };
  } catch (err) {
    return errorResult('config', String(err), { at, command: 'watch' }, formatSniff(argv));
  }
  if (!['json', 'text'].includes(values.format))
    return errorResult('config', '--format must be json or text', { at, command: 'watch' }, 'json');
  const expected = action === 'ls' ? 0 : 1;
  if (values.positionals.length !== expected)
    return errorResult(
      'config',
      `watch ${action} requires exactly ${expected} item argument(s)`,
      { at, command: 'watch' },
      values.format,
    );
  let dir = values['watch-dir'];
  let scopedRepo;
  if (dir && values.repo !== undefined) {
    const validated = validateRepo(values.repo);
    if (!validated.ok)
      return errorResult('config', validated.error, { at, command: 'watch' }, values.format);
    scopedRepo = validated.repo;
  }
  if (!dir) {
    const rawRepo = values.repo ?? (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)().repo;
    const repo = validateRepo(rawRepo);
    const id = validateMonitorId(
      selectedMonitorId(values, deps.env ?? process.env, deps.defaultMonitor ?? defaultMonitorId),
    );
    if (!repo.ok || !id.ok)
      return errorResult(
        'config',
        'missing --repo and could not derive owner/name from local git remotes',
        { at, command: 'watch' },
        values.format,
      );
    dir = watchDirPath(repo.repo, id.monitorId, values['state-dir'] ?? defaultStateDir());
  }
  try {
    const item = values.positionals?.[0];
    const result =
      action === 'add'
        ? addWatch(dir, item, values.until, { now, ...(scopedRepo ? { repo: scopedRepo } : {}) })
        : action === 'rm'
          ? removeWatch(dir, item, scopedRepo ? { repo: scopedRepo } : {})
          : { entries: listWatch(dir) };
    return {
      code: 0,
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: `watch ${action}`,
        watchDir: dir,
        at,
        ...(item ? { item } : {}),
        ...result,
        summary: action === 'ls' ? `${result.entries.length} watch item(s)` : `${action} complete`,
      },
      format: values.format,
    };
  } catch (err) {
    return errorResult(
      err.message?.includes('watch item') ||
        err.message?.includes('--until') ||
        err.message?.includes('invalid watch') ||
        err.message?.includes('duplicate')
        ? 'config'
        : 'io',
      String(err.message ?? err),
      { at, command: 'watch' },
      values.format,
    );
  }
}

/**
 * Run the read-only `list` subcommand: inventory the monitor snapshots
 * reachable from a state directory and the run registry. Never contacts GitHub
 * and never writes state, so the only failure kinds are `config` (bad flags)
 * and `io` (unreadable directory).
 *
 * Without `--state-dir` the inventory is global: the run registry plus the
 * temp-dir default location. An explicit `--state-dir` narrows the inventory
 * to a plain scan of that directory.
 *
 * @param {string[]} argv - Arguments after the `list` token.
 */
function runList(argv, deps = {}) {
  const {
    listMonitors = fsListMonitors,
    now = () => new Date().toISOString(),
    env = process.env,
  } = deps;
  const at = now();
  // Same indestructible-help policy as the detector: literal pre-scan, no parsing.
  if (argv.includes('--help'))
    return { code: 0, report: renderHelpText('gh-delta list'), format: 'json' };
  if (argv.includes('--help-json'))
    return { code: 0, report: renderHelpJson('gh-delta list'), format: 'json' };
  if (argv.includes('--version')) return { code: 0, report: renderVersionText(), format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: LIST_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'list' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult('config', '--format must be json or text', { at, command: 'list' }, 'json');
  let sinceMs = null;
  if (values.since !== undefined) {
    const since = parseSince(values.since);
    if (since.error) return errorResult('config', since.error, { at, command: 'list' }, format);
    sinceMs = since.ms;
  }
  // Explicit --state-dir narrows to that directory; the zero-flag default is
  // the global inventory (run registry + the temp-dir default location).
  const stateDir = values['state-dir'] ?? defaultStateDir();
  const registryDir = values['state-dir'] ? null : defaultRegistryDir({ env });
  let monitors, skippedFiles;
  try {
    ({ monitors, skippedFiles } = listMonitors(stateDir, { sinceMs, now: () => at, registryDir }));
  } catch (err) {
    return errorResult('io', String(err?.message ?? err), { at, command: 'list' }, format);
  }
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command: 'list',
    stateDir,
    registryDir,
    since: values.since ?? null,
    at,
    monitors,
    skippedFiles,
    summary: `${monitors.length} monitor(s)`,
  };
  return { code: 0, report, format };
}

function nonNegativeInt(name, raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  return { value };
}

function commandHelp(argv, command) {
  if (argv.includes('--help')) return renderHelpText(command);
  if (argv.includes('--help-json')) return renderHelpJson(command);
  if (argv.includes('--version')) return renderVersionText();
  return null;
}

// Consumer-side replay: no GitHub, snapshot, registry, or cursor write unless
// --advance is requested. That mutation path takes a cursor-local lock.
function runRead(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    readCursor = fsReadCursor,
    readDeltaLog = fsReadDeltaLog,
    releaseLock = fsReleaseLock,
    setCursorAtomic = fsSetCursorAtomic,
    cursorLockFs,
    cursorLockNow = () => Date.now(),
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta read');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: READ_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'read' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult('config', '--format must be json or text', { at, command: 'read' }, 'json');
  if (!values.cursor)
    return errorResult('config', '--cursor is required', { at, command: 'read' }, format);
  const cursorPath = resolve(values.cursor);
  const only = parseDeltaClassSelection('--only-classes', values['only-classes']);
  if (!only.ok) return errorResult('config', only.error, { at, command: 'read' }, format);
  let number;
  if (values.number !== undefined) {
    number = positiveInt('--number', values.number);
    if (number.error) return errorResult('config', number.error, { at, command: 'read' }, format);
  }
  const lockOpts = cursorLockOptions(cursorLockFs, cursorLockNow);
  let lockToken;
  if (values.advance) {
    let acquired;
    try {
      acquired = acquireLock(cursorPath, lockOpts);
    } catch (err) {
      return errorResult('io', String(err?.message ?? err), { at, command: 'read' }, format);
    }
    if (!acquired.ok)
      return errorResult(
        'busy',
        `cursor locked (${acquired.reason}): ${cursorPath}`,
        { at, command: 'read' },
        format,
      );
    lockToken = acquired.token;
  }
  try {
    let cursor;
    try {
      cursor = readCursor(cursorPath);
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'read' },
        format,
      );
    }
    if (!cursor)
      return errorResult(
        'log',
        `cursor file does not exist: ${cursorPath}`,
        { at, command: 'read' },
        format,
      );
    let scanned;
    try {
      scanned = readDeltaLog(cursor.logFile, {
        afterSeq: cursor.seq,
        select: (entry) =>
          (only.classes.length === 0 ||
            entry.delta.classes?.some((klass) => only.classes.includes(klass))) &&
          (number === undefined || entry.delta.number === number.value),
      });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'read' },
        format,
      );
    }
    if (cursor.seq > scanned.lastSeq) {
      return errorResult(
        'log',
        `cursor seq ${cursor.seq} is above complete log tail ${scanned.lastSeq}: ${cursor.logFile}`,
        { at, command: 'read' },
        format,
      );
    }
    const warnings =
      cursor.seq + 1 < scanned.firstSeq
        ? [{ label: 'retention', reason: 'cursor behind retention' }]
        : [];
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'read',
      logFile: cursor.logFile,
      at,
      cursor: { path: cursorPath, from: cursor.seq, to: scanned.scannedTo, advanced: false },
      deltas: scanned.entries.map((entry) => entry.delta),
      summary: `${scanned.entries.length} delta(s)`,
    };
    if (values.advance) {
      try {
        extendLockDeadline(cursorPath, lockToken, lockOpts);
        if (!assertLockOwned(cursorPath, lockToken, lockOpts))
          return errorResult(
            'busy',
            `cursor lock lost before advance: ${cursorPath}`,
            { at, command: 'read' },
            format,
          );
        setCursorAtomic(cursorPath, {
          cursorVersion: 1,
          logFile: cursor.logFile,
          seq: scanned.scannedTo,
        });
      } catch (err) {
        return errorResult(
          err?.kind === 'log' ? 'log' : 'io',
          String(err?.message ?? err),
          { at, command: 'read' },
          format,
        );
      }
      report.cursor.advanced = true;
    }
    return { code: report.deltas.length ? 10 : 0, report, format, warnings };
  } finally {
    if (lockToken) releaseLock(cursorPath, lockToken, lockOpts);
  }
}

function runCompact(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    releaseLock = fsReleaseLock,
    compactDeltaLog = fsCompactDeltaLog,
    now = () => new Date().toISOString(),
    lockNow = () => Date.now(),
    lockFs,
    env = process.env,
    defaultMonitor = defaultMonitorId,
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta log compact');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: COMPACT_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'log compact' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult(
      'config',
      '--format must be json or text',
      { at, command: 'log compact' },
      'json',
    );
  if (!values.keep)
    return errorResult('config', '--keep is required', { at, command: 'log compact' }, format);
  let keep;
  if (
    /^[0-9]+$/.test(values.keep) &&
    Number.isSafeInteger(Number(values.keep)) &&
    Number(values.keep) > 0
  )
    keep = { count: Number(values.keep) };
  else {
    const duration = parseDuration(values.keep, { flag: '--keep' });
    if (duration.error)
      return errorResult(
        'config',
        '--keep must be a positive safe integer count or positive duration (e.g. 7d)',
        { at, command: 'log compact' },
        format,
      );
    const cutoff = Date.parse(at) - duration.ms;
    if (!Number.isSafeInteger(duration.ms) || !Number.isSafeInteger(cutoff))
      return errorResult(
        'config',
        '--keep duration is outside the supported safe integer range',
        { at, command: 'log compact' },
        format,
      );
    keep = { sinceMs: cutoff };
  }
  if (!!values['state-file'] === !!values['state-dir'])
    return errorResult(
      'config',
      'exactly one of --state-file or --state-dir is required',
      { at, command: 'log compact' },
      format,
    );
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok)
    return errorResult('config', monitor.error, { at, command: 'log compact' }, format);
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at, command: 'log compact' },
      format,
    );
  const repo = validateRepo(values.repo);
  if (!repo.ok)
    return errorResult(
      'config',
      values.repo ? repo.error : '--repo is required for log compact',
      { at, command: 'log compact' },
      format,
    );
  const stateFile =
    values['state-file'] ?? snapshotPath(repo.repo, monitorId, entities.key, values['state-dir']);
  const logFile = resolve(
    deltaLogPath(
      values['state-file']
        ? { stateFile }
        : { stateDir: values['state-dir'], repo: repo.repo, monitorId, entities: entities.key },
    ),
  );
  const lockOpts = { ghTimeoutMs: 60000, staleMs: 600000, fs: lockFs, now: lockNow };
  let token;
  try {
    const acquired = acquireLock(stateFile, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `state file locked (${acquired.reason}): ${stateFile}`,
        { at, command: 'log compact' },
        format,
      );
    token = acquired.token;
    const result = compactDeltaLog(
      logFile,
      { keep },
      {
        onProgress: () => extendLockDeadline(stateFile, token, lockOpts),
        verifyBeforeMutation: () => assertLockOwned(stateFile, token, lockOpts),
      },
    );
    return {
      code: 0,
      format,
      warnings: [],
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'log compact',
        logFile,
        at,
        keep: values.keep,
        ...result,
        summary: `retained ${result.retained.count} record(s)`,
      },
    };
  } catch (err) {
    return errorResult(
      err?.code === 'LOCK_LOST' ? 'busy' : err?.kind === 'log' ? 'log' : 'io',
      String(err?.message ?? err),
      { at, command: 'log compact' },
      format,
    );
  } finally {
    if (token) releaseLock(stateFile, token, lockOpts);
  }
}

// The public `reset` state command: re-baselining a monitor used to require
// parsing a `snapshot`/`log` error and deleting owned state by hand.
// Deletes the snapshot, the log manifest, and the log's physical dataFile
// under the monitor lock; the lock is released last (the `finally` below) so
// a concurrent tick waiting on it can never observe a half-deleted monitor.
function runReset(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    releaseLock = fsReleaseLock,
    resetDeltaLog = fsResetDeltaLog,
    deleteSnapshot = fsDeleteSnapshot,
    now = () => new Date().toISOString(),
    lockNow = () => Date.now(),
    lockFs,
    env = process.env,
    defaultMonitor = defaultMonitorId,
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta reset');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: RESET_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'reset' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult('config', '--format must be json or text', { at, command: 'reset' }, 'json');
  if (!values.yes)
    return errorResult(
      'config',
      'reset deletes the snapshot and durable log for this monitor; pass --yes to confirm',
      { at, command: 'reset' },
      format,
    );
  if (!!values['state-file'] === !!values['state-dir'])
    return errorResult(
      'config',
      'exactly one of --state-file or --state-dir is required',
      { at, command: 'reset' },
      format,
    );
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok) return errorResult('config', monitor.error, { at, command: 'reset' }, format);
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at, command: 'reset' },
      format,
    );
  const repo = validateRepo(values.repo);
  if (!repo.ok)
    return errorResult(
      'config',
      values.repo ? repo.error : '--repo is required for reset',
      { at, command: 'reset' },
      format,
    );
  const stateFile =
    values['state-file'] ?? snapshotPath(repo.repo, monitorId, entities.key, values['state-dir']);
  const logFile = resolve(
    deltaLogPath(
      values['state-file']
        ? { stateFile }
        : { stateDir: values['state-dir'], repo: repo.repo, monitorId, entities: entities.key },
    ),
  );
  const lockOpts = { ghTimeoutMs: 60000, staleMs: 600000, fs: lockFs, now: lockNow };
  let token;
  try {
    const acquired = acquireLock(stateFile, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `state file locked (${acquired.reason}): ${stateFile}`,
        { at, command: 'reset' },
        format,
      );
    token = acquired.token;
    deleteSnapshot(stateFile);
    resetDeltaLog(logFile);
    return {
      code: 0,
      format,
      warnings: [],
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'reset',
        stateFile,
        logFile,
        at,
        summary: `reset ${stateFile}`,
      },
    };
  } catch (err) {
    return errorResult(
      err?.code === 'LOCK_LOST' ? 'busy' : err?.kind === 'log' ? 'log' : 'io',
      String(err?.message ?? err),
      { at, command: 'reset' },
      format,
    );
  } finally {
    // Released last: a concurrent tick blocked on this lock is guaranteed to
    // see either the fully-intact pre-reset state or the fully-clean
    // post-reset state, never a half-deleted one.
    if (token) releaseLock(stateFile, token, lockOpts);
  }
}

function runCursorSet(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    readCursor = fsReadCursor,
    readDeltaLog = fsReadDeltaLog,
    releaseLock = fsReleaseLock,
    setCursorAtomic = fsSetCursorAtomic,
    cursorLockFs,
    cursorLockNow = () => Date.now(),
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta cursor set');
  if (help) return { code: 0, report: help, format: 'json' };
  if (argv.length < 2)
    return errorResult(
      'config',
      'cursor set requires <cursor-path> <seq>',
      { at, command: 'cursor set' },
      formatSniff(argv),
    );
  const [rawCursorPath, rawSeq, ...optionArgs] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: optionArgs, options: CURSOR_SET_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'cursor set' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult(
      'config',
      '--format must be json or text',
      { at, command: 'cursor set' },
      'json',
    );
  const seq = nonNegativeInt('<seq>', rawSeq);
  if (seq.error) return errorResult('config', seq.error, { at, command: 'cursor set' }, format);
  const cursorPath = resolve(rawCursorPath);
  const lockOpts = cursorLockOptions(cursorLockFs, cursorLockNow);
  let lockToken;
  try {
    const acquired = acquireLock(cursorPath, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `cursor locked (${acquired.reason}): ${cursorPath}`,
        { at, command: 'cursor set' },
        format,
      );
    lockToken = acquired.token;
  } catch (err) {
    return errorResult('io', String(err?.message ?? err), { at, command: 'cursor set' }, format);
  }
  try {
    let existing;
    try {
      existing = readCursor(cursorPath);
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    if (!existing && !values['log-file'])
      return errorResult(
        'config',
        '--log-file is required to initialize a cursor',
        { at, command: 'cursor set' },
        format,
      );
    const logFile = values['log-file'] ? resolve(values['log-file']) : existing.logFile;
    if (existing && values['log-file'] && logFile !== existing.logFile)
      return errorResult(
        'config',
        '--log-file must match the existing cursor binding',
        { at, command: 'cursor set' },
        format,
      );
    let scanned;
    try {
      scanned = readDeltaLog(logFile, { afterSeq: 0 });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    if (seq.value > scanned.lastSeq)
      return errorResult(
        'log',
        `cursor seq ${seq.value} is above complete log tail ${scanned.lastSeq}: ${logFile}`,
        { at, command: 'cursor set' },
        format,
      );
    try {
      extendLockDeadline(cursorPath, lockToken, lockOpts);
      if (!assertLockOwned(cursorPath, lockToken, lockOpts))
        return errorResult(
          'busy',
          `cursor lock lost before set: ${cursorPath}`,
          { at, command: 'cursor set' },
          format,
        );
      setCursorAtomic(cursorPath, { cursorVersion: 1, logFile, seq: seq.value });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'cursor set',
      at,
      cursor: { path: cursorPath, logFile, from: existing?.seq ?? 0, to: seq.value },
      summary: `cursor set to ${seq.value}`,
    };
    return { code: 0, report, format, warnings: [] };
  } finally {
    if (lockToken) releaseLock(cursorPath, lockToken, lockOpts);
  }
}

// deps keeps the CLI testable without shelling out to gh or touching disk.
/**
 * Run one detector pass and return a machine-readable result.
 *
 * The function performs argument validation, fetches requested GitHub entity
 * families, compares them with the prior snapshot, and writes the next snapshot
 * only after a successful fetch and diff. It never exits the process directly.
 * A leading `list` token routes to the read-only inventory subcommand instead.
 */
function runSchema(argv, deps = {}) {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const help = commandHelp(argv, 'gh-delta schema');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: SCHEMA_OPTIONS }));
  } catch (err) {
    return errorResult('config', String(err), { at, command: 'schema' }, formatSniff(argv));
  }
  if (!['json', 'compact', 'ndjson'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json, compact, or ndjson',
      { at, command: 'schema' },
      'json',
    );
  return { code: 0, report: schemaFor(values.format), format: 'schema' };
}

function runStatus(argv, deps = {}) {
  const configured = applyConfig(argv, configDeps(deps), {
    allowedKeys: Object.keys(STATUS_OPTIONS),
  });
  if (!configured.ok)
    return errorResult(
      'config',
      configured.error,
      { at: (deps.now ?? (() => new Date().toISOString()))(), command: 'status' },
      formatSniff(argv),
    );
  argv = configured.argv;
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const help = commandHelp(argv, 'gh-delta status');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: STATUS_OPTIONS }));
  } catch (error) {
    return errorResult(
      'config',
      String(error?.message ?? error),
      { at, command: 'status' },
      formatSniff(argv),
    );
  }
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at, command: 'status' },
      'json',
    );
  if (values.refresh) {
    const refreshArgs = argv.filter((arg) => arg !== '--refresh');
    const refreshed = runSingle(refreshArgs, deps);
    if (refreshed.code !== 0 && refreshed.code !== 10) return refreshed;
    // The full detector can resolve a GitHub Enterprise/SSH remote through its
    // gh fallback. Reuse that exact result for the local read instead of
    // re-running status's deliberately local-only resolver.
    return runStatus([...refreshArgs, '--repo', refreshed.report.repo], deps);
  }
  if (values['state-file'] && values['state-dir'])
    return errorResult(
      'config',
      '--state-file and --state-dir are mutually exclusive',
      { at, command: 'status' },
      values.format,
    );
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at, command: 'status' },
      values.format,
    );
  const numbers = watchNumbers(values.number);
  if (!numbers.ok)
    return errorResult('config', numbers.error, { at, command: 'status' }, values.format);
  let repo = values.repo;
  if (!repo) {
    const local = (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)();
    if (local.status !== 'found')
      return errorResult(
        'config',
        'missing --repo and could not derive owner/name from local git remotes',
        { at, command: 'status' },
        values.format,
      );
    repo = local.repo;
  }
  const valid = validateRepo(repo);
  if (!valid.ok)
    return errorResult('config', valid.error, { at, command: 'status' }, values.format);
  const monitorId = selectedMonitorId(
    values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok)
    return errorResult(
      'config',
      monitor.error,
      { at, command: 'status', repo: valid.repo, monitorId },
      values.format,
    );
  let watches = [];
  if (values['watch-dir'] !== undefined) {
    try {
      watches = readWatch(values['watch-dir']).filter(
        (entry) => entry.repo === undefined || entry.repo === valid.repo,
      );
    } catch (error) {
      return errorResult(
        'config',
        String(error?.message ?? error),
        { at, command: 'status', repo: valid.repo, monitorId },
        values.format,
      );
    }
  }
  const economicalWatch =
    values['watch-dir'] !== undefined &&
    entities.wantsPr &&
    watches.length <= 10 &&
    watches.every((entry) => entry.entity === 'pr');
  let stateFile = values['state-file'];
  if (stateFile && economicalWatch) {
    stateFile = economicalSnapshotPath(valid.repo, monitorId, entities.key, null, { stateFile });
  } else if (!stateFile) {
    const stateDir = values['state-dir'] ?? defaultStateDir();
    stateFile = economicalWatch
      ? economicalSnapshotPath(valid.repo, monitorId, entities.key, stateDir)
      : snapshotPath(valid.repo, monitorId, entities.key, stateDir);
  }
  let snapshot;
  try {
    snapshot = (deps.readSnapshot ?? fsRead)(stateFile);
  } catch (error) {
    return errorResult(
      'snapshot',
      String(error?.message ?? error),
      { at, command: 'status', repo: valid.repo, monitorId },
      values.format,
    );
  }
  const items = entities.selected
    .flatMap((entity) =>
      Object.entries(snapshot?.[entity] ?? {})
        .filter(
          ([number, item]) =>
            item.fingerprint.state === 'open' &&
            (!numbers.numbers || numbers.numbers.has(Number(number))),
        )
        .map(([number, item]) => ({
          entity,
          number: Number(number),
          title: item.context?.title ?? null,
          author: item.context?.author ?? null,
          summary: entity === 'pr' ? deltaSummary({ entity, to: item }) : null,
          lastChangedAt: item.meta?.changedAt ?? null,
          ticksSinceChange: item.meta?.ticksSinceChange ?? 0,
        })),
    )
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.number - b.number);
  return {
    code: 0,
    format: values.format,
    warnings: [],
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'status',
      repo: valid.repo,
      monitorId,
      stateFile,
      at,
      items,
      summary: `${items.length} open item(s)`,
    },
  };
}

function parseCommandValues(argv, command, options, deps) {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const help = commandHelp(argv, `gh-delta ${command}`);
  if (help) return { help, at };
  const configured = applyConfig(argv, configDeps(deps), { allowedKeys: Object.keys(options) });
  if (!configured.ok)
    return {
      error: errorResult('config', configured.error, { at, command }, formatSniff(argv)),
      at,
    };
  argv = configured.argv;
  try {
    return {
      values: parseArgs({ args: argv, options, allowPositionals: command === 'explain' }),
      at,
    };
  } catch (error) {
    return {
      error: errorResult(
        'config',
        String(error?.message ?? error),
        { at, command },
        formatSniff(argv),
      ),
      at,
    };
  }
}

function runInit(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'init', INIT_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'init' },
      'json',
    );
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at: parsed.at, command: 'init' },
      values.format,
    );
  const local = values.repo
    ? { status: 'found', repo: values.repo }
    : (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)();
  if (local.status !== 'found')
    return errorResult(
      'config',
      'init requires --repo or a repository remote in the current directory',
      { at: parsed.at, command: 'init' },
      values.format,
    );
  const repo = validateRepo(local.repo);
  if (!repo.ok)
    return errorResult('config', repo.error, { at: parsed.at, command: 'init' }, values.format);
  const monitorId = selectedMonitorId(
    values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok)
    return errorResult(
      'config',
      monitor.error,
      { at: parsed.at, command: 'init', repo: repo.repo },
      values.format,
    );
  const stateDir = resolve(values['state-dir'] ?? join(process.cwd(), '.gh-delta'));
  const configPath = resolve(process.cwd(), '.gh-delta.json');
  const entityValue = entities.selected.join(',');
  const stateFile = snapshotPath(repo.repo, monitorId, entities.key, stateDir);
  const result = initializeMonitor(
    { repo: repo.repo, stateDir, monitorId, entities: entityValue, configPath, stateFile },
    {
      existsSync: deps.existsSync ?? existsSync,
      writeFileSync: deps.writeFileSync ?? writeFileSync,
      writeConfig:
        deps.writeConfig ??
        (deps.writeFileSync
          ? undefined
          : (path, config) => writeConfigDurableNoOverwrite(path, config, { fs: deps.configFs })),
      isTemporaryPath: deps.isTemporaryPath,
      tick: () =>
        run(
          [
            '--repo',
            repo.repo,
            '--monitor-id',
            monitorId,
            '--state-dir',
            stateDir,
            '--entities',
            entityValue,
          ],
          deps,
        ),
    },
  );
  if (result.error)
    return errorResult(
      result.kind ?? 'config',
      result.error,
      { at: parsed.at, command: 'init', repo: repo.repo, monitorId },
      values.format,
    );
  const report = {
    ...result.report,
    at: parsed.at,
    ...(values.agent
      ? {
          agent: {
            cron: `* * * * * cd ${shellQuote(process.cwd())} && ${agentCommand(repo.repo, monitorId, entityValue, stateDir).map(shellQuote).join(' ')} >/dev/null`,
            systemd: `WorkingDirectory=${systemdQuote(process.cwd())}\nExecStart=${agentCommand(repo.repo, monitorId, entityValue, stateDir).map(systemdQuote).join(' ')}`,
            prompt:
              'Run gh-delta, inspect JSON only when exit code is 10, and never merge without approval.',
          },
        }
      : {}),
  };
  return { code: result.code, report, format: values.format, warnings: [] };
}

function runDoctor(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'doctor', DOCTOR_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'doctor' },
      'json',
    );
  const local = values.repo
    ? { status: 'found', repo: values.repo }
    : (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)();
  if (local.status !== 'found')
    return errorResult(
      'config',
      'doctor requires --repo or a repository remote in the current directory',
      { at: parsed.at, command: 'doctor' },
      values.format,
    );
  const repo = validateRepo(local.repo);
  if (!repo.ok)
    return errorResult('config', repo.error, { at: parsed.at, command: 'doctor' }, values.format);
  const monitorId = selectedMonitorId(
    values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  const stateDir = resolve(values['state-dir'] ?? join(process.cwd(), '.gh-delta'));
  const exec =
    deps.doctorExec ??
    ((command, args) =>
      execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const safeGh = (args) => {
    try {
      exec('gh', args);
      return true;
    } catch {
      return false;
    }
  };
  const activeGhAccount = () => {
    try {
      const hosts = JSON.parse(
        exec('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']),
      ).hosts;
      return Object.values(hosts ?? {}).some(
        (accounts) =>
          Array.isArray(accounts) &&
          accounts.some(
            (account) =>
              (account.active === true || account.is_active === true) &&
              typeof account.login === 'string' &&
              account.login.length > 0,
          ),
      );
    } catch {
      return false;
    }
  };
  const inferredOrgScope = () => {
    try {
      const owner = JSON.parse(exec('gh', ['api', `repos/${repo.repo}`])).owner?.type;
      if (owner !== 'Organization') return { needed: false, ok: true };
      const auth = JSON.parse(
        exec('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']),
      );
      const scopes = JSON.stringify(auth).match(/"scopes"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
      return { needed: true, ok: /"read:org"/.test(scopes) };
    } catch {
      // Auth/API failure is independently represented by the gh rows; do not
      // invent a scope failure from an unreadable diagnostic response.
      return { needed: false, ok: true };
    }
  };
  const result = runDoctorChecks(
    { repo: repo.repo, stateDir, monitorId, machineId: deps.machineId ?? defaultMachineId() },
    {
      ghInstalled: () => safeGh(['--version']),
      ghAuthenticated: activeGhAccount,
      orgScope: deps.orgScope ?? inferredOrgScope,
      graphqlRateLimit: deps.fetchRateLimit ?? (() => ghRateLimit({ exec })),
      stateDir: deps.inspectStateDir ?? defaultStateDirInspection,
      nodeVersion: deps.nodeVersion,
      registryEntries:
        deps.registryEntries ??
        (() =>
          (deps.readRegistry ?? fsReadRegistry)(
            defaultRegistryDir({ env: deps.env ?? process.env }),
          ).entries),
      isTemporaryPath: deps.isTemporaryPath,
    },
  );
  return {
    ...result,
    report: { ...result.report, at: parsed.at },
    format: values.format,
    warnings: [],
  };
}

function runExplain(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'explain', EXPLAIN_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values, positionals } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'explain' },
      'json',
    );
  if (positionals.length !== 1 || !/^[0-9a-f]{64}$/.test(positionals[0]))
    return errorResult(
      'config',
      'explain requires one 64-character delta id',
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  if (Boolean(values['log-file']) === Boolean(values['report-file']))
    return errorResult(
      'config',
      'explain requires exactly one of --log-file or --report-file',
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  try {
    const deltas = values['log-file']
      ? (deps.readDeltaLog ?? fsReadDeltaLog)(values['log-file']).entries.map(
          (entry) => entry.delta,
        )
      : (JSON.parse((deps.readFileSync ?? readFileSync)(values['report-file'], 'utf8')).deltas ??
        []);
    const result = explainDelta(positionals[0], deltas);
    if (result.error)
      return errorResult(
        'config',
        result.error,
        { at: parsed.at, command: 'explain' },
        values.format,
      );
    return {
      ...result,
      report: { ...result.report, at: parsed.at },
      format: values.format,
      warnings: [],
    };
  } catch (error) {
    return errorResult(
      'io',
      String(error?.message ?? error),
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  }
}

function runDemo(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'demo', DEMO_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'demo' },
      'json',
    );
  return {
    code: 0,
    format: values.format,
    warnings: [],
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'demo',
      at: parsed.at,
      repo: 'diegomarino/gh-delta-demo',
      commandLine: 'gh-delta --repo diegomarino/gh-delta-demo --state-dir .gh-delta-demo',
    },
  };
}

const WAIT_ONLY_OPTIONS = new Set([
  'timeout',
  'until',
  'until-summary',
  'interval',
  'max-interval',
  'backoff',
  'settle',
  'heartbeat-file',
  'progress',
  'from-log',
  'cursor',
]);

function waitHelp(argv) {
  if (argv.includes('--help')) return renderHelpText('gh-delta wait');
  if (argv.includes('--help-json')) return renderHelpJson('gh-delta wait');
  if (argv.includes('--version')) return renderVersionText();
  return null;
}

function waitConfigError(argv, deps, message, format = 'json') {
  return errorResult(
    'config',
    message,
    { at: (deps.now ?? (() => new Date().toISOString()))(), command: 'wait' },
    format,
  );
}

function parseWaitSummary(raw) {
  if (raw === undefined) return { ok: true, condition: null };
  const [field, values] = String(raw).split('=', 2);
  const selectedRaw =
    values
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (!DELTA_SUMMARY_FIELDS.includes(field) || selectedRaw.length === 0)
    return { ok: false, error: '--until-summary must be field=value[,value...]' };
  // failedChecks is an array of {name, runId?, jobId?, detailsUrl} objects,
  // not a scalar -- the equality-against-a-Set matching below can never match
  // it, so a predicate on it would silently never fire. Reject it explicitly
  // instead of accepting a condition that can never be satisfied.
  if (field === 'failedChecks')
    return {
      ok: false,
      error:
        '--until-summary failedChecks is not supported (failedChecks is a list, not a scalar value); use --until ci-changed or inspect delta.summary.failedChecks after the wait',
    };
  let selected;
  if (field === 'isDraft') {
    if (selectedRaw.some((value) => !['true', 'false'].includes(value)))
      return { ok: false, error: '--until-summary isDraft values must be true or false' };
    selected = selectedRaw.map((value) => value === 'true');
  } else if (field === 'unresolvedReviewThreads') {
    if (selectedRaw.some((value) => !/^(0|[1-9][0-9]*)$/.test(value)))
      return {
        ok: false,
        error: '--until-summary unresolvedReviewThreads values must be non-negative integers',
      };
    selected = selectedRaw.map(Number);
  } else if (field in DELTA_SUMMARY_ENUMS) {
    if (selectedRaw.some((value) => !DELTA_SUMMARY_ENUMS[field].includes(value)))
      return { ok: false, error: `--until-summary ${field} must use its documented enum values` };
    selected = selectedRaw;
  } else selected = selectedRaw;
  return { ok: true, condition: { field, values: new Set(selected) } };
}

function stripWaitOptions(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      result.push(arg);
      continue;
    }
    const name = arg.slice(2).split('=', 1)[0];
    if (!WAIT_ONLY_OPTIONS.has(name)) {
      result.push(arg);
      continue;
    }
    if (!arg.includes('=') && WAIT_OPTIONS[name]?.type === 'string') index++;
  }
  return result;
}

// Reads `delta.summary`, already computed by `enrichDelta()` while `delta.to`
// still carried the full snapshot item deltaSummary() needs. By the time a
// delta reaches a tick report (or the durable log, for --from-log), `to` has
// been stripped to the bare fingerprint (see the strip comment in
// `runSingle`), so recomputing via `deltaSummary(delta)` here would silently
// return null -- `delta.summary` is the one already-correct value.
function waitSummaryMatches(report, condition, numbers) {
  if (!condition) return false;
  return (report.deltas ?? []).some(
    (delta) =>
      (!numbers || numbers.has(delta.number)) &&
      condition.values.has(delta.summary?.[condition.field]),
  );
}

function snapshotSummaryMatches(snapshot, condition, numbers) {
  if (!condition || !snapshot || typeof snapshot !== 'object') return false;
  return Object.entries(snapshot.pr ?? {}).some(
    ([number, item]) =>
      (!numbers || numbers.has(Number(number))) &&
      condition.values.has(deltaSummary({ entity: 'pr', to: item })?.[condition.field]),
  );
}

function touchHeartbeat(path) {
  try {
    utimesSync(path, new Date(), new Date());
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
  }
}

function positiveNumber(name, raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? { value }
    : { error: `${name} must be a positive number; got "${raw}"` };
}

// Bounded worker loop. Detector ticks deliberately remain synchronous: every
// call to run() obtains and releases its own state lock before this function
// awaits a delay, so a sleeping worker can never keep another monitor busy.
async function runWait(argv, deps = {}) {
  const help = waitHelp(argv);
  if (help) return { code: 0, report: help, format: 'json', warnings: [], progress: '' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: WAIT_OPTIONS }));
  } catch (error) {
    const result = waitConfigError(argv, deps, String(error?.message ?? error), formatSniff(argv));
    return { ...result, warnings: [], progress: '' };
  }
  const format = values.format;
  if (format !== 'json') {
    const result = waitConfigError(argv, deps, 'wait supports only --format json', 'json');
    return { ...result, warnings: [], progress: '' };
  }
  if (!values.timeout) {
    const result = waitConfigError(argv, deps, '--timeout is required', format);
    return { ...result, warnings: [], progress: '' };
  }
  const timeout = parseDuration(values.timeout, { flag: '--timeout' });
  const interval = parseDuration(values.interval, { flag: '--interval' });
  const maxInterval = values['max-interval']
    ? parseDuration(values['max-interval'], { flag: '--max-interval' })
    : null;
  const settle = values.settle ? parseDuration(values.settle, { flag: '--settle' }) : { ms: 0 };
  const backoff = positiveNumber('--backoff', values.backoff);
  const until = parseDeltaClassSelection('--until', values.until);
  const untilSummary = parseWaitSummary(values['until-summary']);
  const numberSelection = watchNumbers(values.number);
  for (const parsed of [
    timeout,
    interval,
    maxInterval,
    settle,
    backoff,
    until,
    untilSummary,
    numberSelection,
  ]) {
    if (parsed?.error) {
      const result = waitConfigError(argv, deps, parsed.error, format);
      return { ...result, warnings: [], progress: '' };
    }
  }
  if (maxInterval && maxInterval.ms < interval.ms) {
    const result = waitConfigError(
      argv,
      deps,
      '--max-interval must be at least --interval',
      format,
    );
    return { ...result, warnings: [], progress: '' };
  }
  if (!until.classes.length && !untilSummary.condition) {
    const result = waitConfigError(
      argv,
      deps,
      'wait requires --until and/or --until-summary',
      format,
    );
    return { ...result, warnings: [], progress: '' };
  }
  if (values['from-log'] && !values.cursor) {
    const result = waitConfigError(argv, deps, '--from-log requires --cursor', format);
    return { ...result, warnings: [], progress: '' };
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const clock = deps.clock ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const readSnapshot = deps.readSnapshot ?? fsRead;
  const writeHeartbeat = deps.touchHeartbeat ?? touchHeartbeat;
  const isSignaled = deps.isSignaled ?? (() => false);
  const tickArgv = stripWaitOptions(argv);
  const explicitWaitRepos = explicitRepos(tickArgv).repos ?? [];
  const waitEntities = parseEntitySelection(values.entities);
  const waitMonitorId = selectedMonitorId(
    values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  const derivedWaitStateFiles = values['state-file']
    ? [resolve(values['state-file'])]
    : explicitWaitRepos.map((repo) =>
        snapshotPath(repo, waitMonitorId, waitEntities.key, values['state-dir']),
      );
  let heartbeatFile =
    values['heartbeat-file'] ??
    (values['from-log']
      ? `${resolve(values.cursor)}.hb`
      : values['state-file']
        ? `${resolve(values['state-file'])}.hb`
        : derivedWaitStateFiles.length === 1
          ? `${derivedWaitStateFiles[0]}.hb`
          : undefined);
  const waited = await runBoundedWait({
    timeoutMs: timeout.ms,
    intervalMs: interval.ms,
    maxIntervalMs: maxInterval?.ms,
    backoff: backoff.value,
    settleMs: settle.ms,
    now,
    clock,
    sleep,
    isSignaled,
    handleSignals: deps.handleSignals !== false,
    progress: values.progress,
    onProgress: deps.onProgress,
    heartbeatFile,
    // A tick report's own `results[].stateFile` (populated for every repo the
    // tick actually resolved -- explicit or autodetected) is preferred over
    // `derivedWaitStateFiles`, which is empty whenever `wait` itself got no
    // `--repo`/`--state-file` and relies on tick-time repo autodetection.
    // Only touch it when it unambiguously names exactly one file -- multiple
    // repos have no single shared heartbeat to pick, same as the
    // `derivedWaitStateFiles.length === 1` rule above.
    heartbeatFileFor: (tickReport) => {
      if (heartbeatFile) return heartbeatFile;
      const stateFiles = (tickReport.results ?? []).map((r) => r.stateFile).filter(Boolean);
      if (stateFiles.length === 1) heartbeatFile = `${stateFiles[0]}.hb`;
      return heartbeatFile;
    },
    touchHeartbeat: (path) => writeHeartbeat(path),
    tick: () => {
      const result = values['from-log']
        ? run(
            [
              'read',
              '--cursor',
              values.cursor,
              '--advance',
              ...(values.number ? ['--number', values.number] : []),
              ...(values.until && !untilSummary.condition ? ['--only-classes', values.until] : []),
            ],
            deps,
          )
        : run(tickArgv, deps);
      return result;
    },
    matches: (tickReport, iterations) => {
      const futureMatch =
        until.classes.length > 0 &&
        (tickReport.deltas ?? []).some((delta) =>
          delta.classes.some((klass) => until.classes.includes(klass)),
        );
      const tickStateFiles = (tickReport.results ?? []).map((r) => r.stateFile).filter(Boolean);
      const stateFilesToCheck = tickStateFiles.length ? tickStateFiles : derivedWaitStateFiles;
      const currentMatch =
        waitSummaryMatches(tickReport, untilSummary.condition, numberSelection.numbers) ||
        (!values['from-log'] &&
          stateFilesToCheck.some((stateFile) => {
            try {
              return snapshotSummaryMatches(
                readSnapshot(stateFile),
                untilSummary.condition,
                numberSelection.numbers,
              );
            } catch {
              return false;
            }
          }));
      if (!currentMatch && !futureMatch) return null;
      return currentMatch && iterations === 1 && !futureMatch ? 'already-satisfied' : 'until';
    },
  });
  if (waited.reason === 'error') {
    // Exit codes 0/1/2/10 are contract: a permanent (2) failure must never be
    // reported as a transient (1) one, which is the direction that makes a
    // supervisor retry forever against something retrying can't fix. Pick
    // the highest-severity error (by the same ERROR_EXIT_CODES a tick's own
    // aggregate code is computed from, not a second parallel rule) rather
    // than the last one collected across a multi-repo tick's results[], and
    // preserve the tick's own already-correct aggregate `waited.code` as
    // authoritative instead of re-deriving it from that error's kind alone.
    const severity = (kind) => ERROR_EXIT_CODES[kind] ?? 1;
    const lastError = [...waited.errors].sort((a, b) => severity(b.kind) - severity(a.kind))[0] ?? {
      kind: 'io',
      message: 'wait failed with no captured error',
    };
    const failed = errorResult(
      lastError.kind,
      lastError.message,
      { at: now(), command: 'wait' },
      format,
    );
    return { ...failed, code: waited.code, warnings: waited.warnings, progress: waited.progress };
  }
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command: 'wait',
    at: now(),
    ...(waited.lastReport?.repos
      ? { repos: waited.lastReport.repos }
      : waited.lastReport?.repo
        ? { repo: waited.lastReport.repo }
        : {}),
    ...(waited.lastReport?.monitorId ? { monitorId: waited.lastReport.monitorId } : {}),
    iterations: waited.iterations,
    reason: waited.reason,
    deltas: waited.deltas,
    ...(waited.errors.length ? { errors: waited.errors } : {}),
    summary: `${waited.reason} after ${waited.iterations} iteration(s); ${waited.deltas.length} delta(s)`,
  };
  return {
    code: waited.code,
    report,
    format,
    warnings: waited.warnings,
    progress: waited.progress,
  };
}

// Sum `cost` across every GraphQL call this tick made (observation fetches
// plus enrichment); keep the last observed `remaining`/`resetAt`. Mirrors
// lib/gh.mjs's and lib/enrich.mjs's own accumulators, one level up.
function accumulateTickRateLimit(a, b) {
  if (!b) return a;
  if (!a) return b;
  return { cost: a.cost + b.cost, remaining: b.remaining, resetAt: b.resetAt };
}

function runSingle(argv, deps = {}) {
  if (argv[0] === 'init') return runInit(argv.slice(1), deps);
  if (argv[0] === 'doctor') return runDoctor(argv.slice(1), deps);
  if (argv[0] === 'explain') return runExplain(argv.slice(1), deps);
  if (argv[0] === 'demo') return runDemo(argv.slice(1), deps);
  if (argv[0] === 'status') return runStatus(argv.slice(1), deps);
  if (argv[0] === 'schema') return runSchema(argv.slice(1), deps);
  if (argv[0] === 'watch') return runWatch(argv.slice(1), deps);
  if (argv[0] === 'log' && argv[1] === 'compact') return runCompact(argv.slice(2), deps);
  if (argv[0] === 'reset') return runReset(argv.slice(1), deps);
  if (argv[0] === 'list') return runList(argv.slice(1), deps);
  if (argv[0] === 'read') return runRead(argv.slice(1), deps);
  if (argv[0] === 'cursor') {
    if (argv[1] === 'set') return runCursorSet(argv.slice(2), deps);
    const at = (deps.now ?? (() => new Date().toISOString()))();
    return errorResult(
      'config',
      'cursor requires the set subcommand',
      { at, command: 'cursor' },
      formatSniff(argv),
    );
  }
  const {
    fetchPRs = ghPRs,
    fetchPRsByNumber = ghPRsByNumber,
    fetchIssues = ghIssues,
    fetchEnrichment = ghEnrichment,
    fetchThreadReplies: fetchThreadRepliesGh = ghThreadReplies,
    fetchRateLimit = ghRateLimit,
    readSnapshot = fsRead,
    writeSnapshotAtomic = fsWrite,
    acquireLock = fsAcquireLock,
    releaseLock = fsReleaseLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    lockNow = () => Date.now(),
    lockFs,
    registerMonitor = fsRegisterMonitor,
    readRegistry = fsReadRegistry,
    defaultMonitor = defaultMonitorId,
    machineId = defaultMachineId(),
    appendDeltaLog = fsAppendDeltaLog,
    now = () => new Date().toISOString(),
    env = process.env,
    resolveRepo = resolveRepoFromGit,
    removeWatchUnchanged: removeWatchedFile = removeWatchUnchanged,
    markTerminalIgnored: markWatchTerminalIgnored = markTerminalIgnored,
  } = deps;
  const at = now();
  const parsed = parseCli(argv);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return errorResult('config', parsed.error, { at }, parsed.format);
  const values = parsed.values;
  const format = parsed.format;
  const ghTimeoutMs = positiveInt('--gh-timeout-ms', values['gh-timeout-ms']);
  if (ghTimeoutMs.error) return errorResult('config', ghTimeoutMs.error, { at }, format);
  const rateLimitFloor =
    values['rate-limit-floor'] === undefined
      ? null
      : nonNegativeSafeInt('--rate-limit-floor', values['rate-limit-floor']);
  if (rateLimitFloor?.error) return errorResult('config', rateLimitFloor.error, { at }, format);
  const lockStaleMs = parseDuration(values['lock-stale-ms'], { flag: '--lock-stale-ms' });
  if (lockStaleMs.error) return errorResult('config', lockStaleMs.error, { at }, format);
  const staleAfter = values['stale-after']
    ? parseDuration(values['stale-after'], { flag: '--stale-after' })
    : null;
  if (staleAfter?.error) return errorResult('config', staleAfter.error, { at }, format);
  // Everything below, up to and including --outpost-max-posts, is repo-
  // INDEPENDENT config validation. It must run before repo derivation
  // (resolveRepo, below) because that can shell out to `gh` -- a network call.
  // A deterministic local config error must always be reported before any
  // GitHub access is attempted, whether the repo came from --repo or from
  // derivation.
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitorValidation = validateMonitorId(monitorId);
  if (!monitorValidation.ok)
    return errorResult('config', monitorValidation.error, { monitorId, at }, format);
  if (values['state-file'] && values['state-dir'])
    return errorResult(
      'config',
      '--state-file and --state-dir are mutually exclusive',
      { monitorId, at },
      format,
    );
  const entitySelection = parseEntitySelection(values.entities);
  if (!entitySelection.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { monitorId, at },
      format,
    );
  if (values['watch-dir'] !== undefined && values.number !== undefined)
    return errorResult(
      'config',
      '--watch-dir and --number are mutually exclusive',
      { monitorId, at },
      format,
    );
  const numberSelection = watchNumbers(values.number);
  if (!numberSelection.ok)
    return errorResult('config', numberSelection.error, { monitorId, at }, format);
  const onlyClasses = parseDeltaClassSelection('--only-classes', values['only-classes']);
  if (!onlyClasses.ok) return errorResult('config', onlyClasses.error, { monitorId, at }, format);
  const ignoreClasses = parseDeltaClassSelection('--ignore-classes', values['ignore-classes']);
  if (!ignoreClasses.ok)
    return errorResult('config', ignoreClasses.error, { monitorId, at }, format);
  const ignoreAuthors = parseIgnoreAuthors(values['ignore-authors']);
  if (!ignoreAuthors.ok)
    return errorResult('config', ignoreAuthors.error, { monitorId, at }, format);
  const enrichmentSelection = parseEnrichmentSelection(values.enrich);
  if (!enrichmentSelection.ok)
    return errorResult('config', enrichmentSelection.error, { monitorId, at }, format);
  const attentionFiltering =
    values['only-classes'] !== undefined ||
    values['ignore-classes'] !== undefined ||
    values['ignore-authors'] !== undefined ||
    values.settled;
  if (!['json', 'text', 'compact', 'ndjson'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json, text, compact, or ndjson',
      { monitorId, at },
      format,
    );
  if (values['outpost-url'] !== undefined) {
    const outpostValidation = validateOutpostUrl(values['outpost-url']);
    if (!outpostValidation.ok)
      return errorResult('config', outpostValidation.error, { monitorId, at }, format);
  }
  if (values['outpost-secret'] !== undefined) {
    const secretName = values['outpost-secret'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName))
      return errorResult(
        'config',
        '--outpost-secret must name an environment variable matching [A-Za-z_][A-Za-z0-9_]*',
        { monitorId, at },
        format,
      );
    if (values['outpost-url'] === undefined)
      return errorResult(
        'config',
        '--outpost-secret requires --outpost-url',
        { monitorId, at },
        format,
      );
    if (typeof env[secretName] !== 'string' || env[secretName].length === 0)
      return errorResult(
        'config',
        `environment variable ${secretName} for --outpost-secret is unset or empty`,
        { monitorId, at },
        format,
      );
  }
  const outpostTimeout = positiveInt('--outpost-timeout-ms', values['outpost-timeout-ms']);
  if (outpostTimeout.error)
    return errorResult('config', outpostTimeout.error, { monitorId, at }, format);
  let outpostMax = { value: Infinity };
  if (values['outpost-max-posts'] !== undefined) {
    outpostMax = positiveInt('--outpost-max-posts', values['outpost-max-posts']);
    if (outpostMax.error) return errorResult('config', outpostMax.error, { monitorId, at }, format);
  }
  // Repo resolution/validation happens last: it is the only phase that can
  // touch the network (resolveRepo -> `gh repo view`), so every deterministic,
  // repo-independent config error above must surface first.
  let earlyWatches = null;
  if (values['watch-dir'] !== undefined) {
    try {
      earlyWatches = readWatch(values['watch-dir']);
    } catch (err) {
      return errorResult('config', String(err.message ?? err), { monitorId, at }, format);
    }
  }
  let repoInput = values.repo;
  let repoSource = 'flag';
  let derivationWarnings = [];
  if (!repoInput) {
    const derived = resolveRepo({ ghTimeoutMs: ghTimeoutMs.value });
    if (derived.status === 'declined')
      return errorResult(
        'config',
        'missing --repo and could not derive owner/name from git remotes (origin/upstream) or gh in the current directory',
        { monitorId, at },
        format,
      );
    if (derived.status === 'failed')
      return errorResult(
        'github',
        `could not derive --repo: ${derived.reason}`,
        { monitorId, at },
        format,
      );
    repoInput = derived.repo;
    repoSource = derived.source;
    derivationWarnings = derived.warnings ?? [];
  }
  const repoValidation = validateRepo(repoInput);
  if (!repoValidation.ok)
    return errorResult('config', repoValidation.error, { repo: repoInput, monitorId, at }, format);
  const repo = repoValidation.repo;
  const ids = { repo, monitorId, at };
  let watches = [],
    selectedNumbers = numberSelection.numbers,
    watchFiles = new Map(),
    effectiveWatchDir;
  if (values['watch-dir'] !== undefined) {
    effectiveWatchDir = values['watch-dir'];
    // A scoped watch belongs only to its named repository. Legacy entries are
    // deliberately assigned to the first selected repo so old directories
    // keep their exact one-repo behavior when composition is introduced.
    watches = earlyWatches.filter(
      (entry) =>
        entry.repo === repo ||
        (entry.repo === undefined &&
          (deps.__multiRepoIndex === undefined || deps.__multiRepoIndex === 0)),
    );
    const effectiveTargets = new Set();
    for (const entry of watches) {
      const target = `${repo}:${entry.entity}:${entry.number}`;
      if (effectiveTargets.has(target))
        return errorResult('config', `duplicate effective watch entry ${target}`, ids, format);
      effectiveTargets.add(target);
    }
    selectedNumbers = new Set(watches.map((entry) => `${entry.entity}:${entry.number}`));
    for (const entry of watches) {
      const path = join(effectiveWatchDir, watchFilename(entry));
      try {
        watchFiles.set(`${entry.entity}:${entry.number}`, {
          entry,
          path,
          bytes: readFileSync(path, 'utf8'),
        });
      } catch {
        return errorResult('config', `invalid watch entry ${path}`, ids, format);
      }
    }
  }
  const economicalWatch =
    values['watch-dir'] !== undefined &&
    entitySelection.wantsPr &&
    watches.length <= 10 &&
    watches.every((entry) => entry.entity === 'pr');
  const usedDefaultDir = !values['state-file'] && !values['state-dir'];
  let stateFile = values['state-file'];
  if (stateFile && economicalWatch) {
    stateFile = economicalSnapshotPath(repo, monitorId, entitySelection.key, null, { stateFile });
  } else if (!stateFile) {
    let baseDir = values['state-dir'];
    if (!baseDir) {
      baseDir = defaultStateDir();
      try {
        // Per-user isolation on shared /tmp. mkdirSync({recursive:true})
        // succeeds silently on a pre-existing dir, so refuse a default dir
        // the current user does not own (no-op on Windows).
        mkdirSync(baseDir, { recursive: true, mode: 0o700 });
        if (typeof process.getuid === 'function') {
          const owner = statSync(baseDir).uid;
          if (owner !== process.getuid()) {
            return errorResult(
              'io',
              `default state dir ${baseDir} is owned by uid ${owner}, not the current user; pass --state-dir explicitly`,
              ids,
              format,
            );
          }
        }
      } catch (err) {
        return errorResult('io', String(err?.message ?? err), ids, format);
      }
    }
    stateFile = economicalWatch
      ? economicalSnapshotPath(repo, monitorId, entitySelection.key, baseDir)
      : snapshotPath(repo, monitorId, entitySelection.key, baseDir);
  }
  const logFile = values.log
    ? resolve(
        deltaLogPath({
          ...(values['state-file'] || economicalWatch ? { stateFile } : {}),
          stateDir: values['state-file'] || economicalWatch ? undefined : dirname(stateFile),
          repo,
          monitorId,
          entities: entitySelection.key,
        }),
      )
    : undefined;
  const registryEnabled = !values['no-registry'] && !envDisablesRegistry(env.GH_DELTA_NO_REGISTRY);
  const usesGeneratedMonitorId = !values['monitor-id'] && !env.GH_DELTA_MONITOR_ID;
  const monitorIdentityWarnings = () => {
    if (!usesGeneratedMonitorId || format !== 'text') return [];
    try {
      const registryDir = defaultRegistryDir({ env });
      const collision = readRegistry(registryDir).entries.some(
        (entry) =>
          entry.repo === repo && entry.machineId === machineId && entry.monitorId !== monitorId,
      );
      return collision
        ? [
            {
              label: 'monitor-id',
              reason: 'multiple local monitor identities exist; pass --monitor-id explicitly',
            },
          ]
        : [];
    } catch {
      // Diagnostic registry reads are best-effort and intentionally silent.
      return [];
    }
  };
  const registerAttempt = (status, error) => {
    if (!registryEnabled) return;
    try {
      registerMonitor({
        repo,
        monitorId,
        entities: economicalWatch ? ['pr'] : entitySelection.selected,
        stateFile,
        ...(economicalWatch ? { scope: 'watch-pr' } : {}),
        ...(effectiveWatchDir ? { watchDir: effectiveWatchDir } : {}),
        machineId,
        at,
        lastRun: at,
        status,
        ...(error ? { error } : {}),
        env,
      });
    } catch {
      // The registry is diagnostics only; it cannot alter detector semantics.
    }
  };
  const failedAttempt = (kind, error, extra = {}) => {
    registerAttempt('failure', { kind, message: String(error?.message ?? error) });
    return {
      ...errorResult(
        kind,
        String(error?.message ?? error),
        { ...ids, repoSource, stateFile, entities: entitySelection.selected, ...extra },
        format,
      ),
      warnings: [...derivationWarnings, ...monitorIdentityWarnings()],
    };
  };

  // Acquire the state-file lock BEFORE reading the snapshot, and BEFORE any
  // GitHub call -- a busy acquisition must never be mistaken for a failed
  // fetch. acquireLock itself ensures the state file's parent directory
  // exists (recursive mkdir, through the same injectable `fs` as the rest of
  // the lock): the directory used to be created lazily by
  // writeSnapshotAtomic at write time, but the lock now runs before the
  // snapshot read/write, so an explicit --state-dir or --state-file whose
  // directory doesn't exist yet would otherwise fail acquireLock's
  // exclusive-create with ENOENT on a first run (the default temp dir above
  // is already created with its own 0700/ownership handling, which stays
  // scoped to that case only -- acquireLock's mkdir is a harmless no-op on
  // an already-existing directory). The initial lease is short (one
  // --gh-timeout-ms + slack, enough for a single `gh` call);
  // fetchPRs/fetchIssues extend it per completed pagination page via
  // onLockProgress below (see docs/contract.md "Lock Semantics").
  const lockDeps = { fs: lockFs, now: lockNow };
  let lockToken;
  let lockWarning;
  try {
    const acquired = acquireLock(stateFile, {
      ghTimeoutMs: ghTimeoutMs.value,
      staleMs: lockStaleMs.ms,
      ...lockDeps,
    });
    if (!acquired.ok) {
      return failedAttempt('busy', `state file locked (${acquired.reason}): ${stateFile}`);
    }
    lockToken = acquired.token;
    if (acquired.warning) lockWarning = { label: 'lock', reason: acquired.warning };
  } catch (err) {
    return failedAttempt('io', err);
  }
  // Invoked by fetchPRs/fetchIssues after each successfully completed
  // pagination page -- ordinary synchronous control flow between two
  // execFileSync calls, not a timer, so it reliably runs. Silently does
  // nothing if ownership was already lost; the pre-write fence is what
  // surfaces that as `busy`.
  const onLockProgress = () => {
    extendLockDeadline(stateFile, lockToken, { ghTimeoutMs: ghTimeoutMs.value, ...lockDeps });
  };

  try {
    let old;
    try {
      old = readSnapshot(stateFile);
      if (economicalWatch && old) {
        // Membership is a projection, not a missing event: a removed watch
        // exits this independent universe before the normal diff lifecycle.
        const watchedNumbers = new Set(watches.map((entry) => String(entry.number)));
        old = {
          ...old,
          pr: Object.fromEntries(
            Object.entries(old.pr).filter(([number]) => watchedNumbers.has(number)),
          ),
          issue: {},
        };
      }
    } catch (err) {
      return failedAttempt('snapshot', err);
    }
    let cutoff;
    try {
      cutoff = horizonCutoff(old);
    } catch (err) {
      return failedAttempt('snapshot', err);
    }
    let current;
    // Accumulated GraphQL quota spend for this tick, summed across every
    // observation family fetched below and every enrichment call further
    // down. Surfaced as `results[].rateLimit` in the report envelope (see
    // buildDetectorReport below).
    let tickRateLimit = null;
    try {
      if (rateLimitFloor !== null) {
        const limit = fetchRateLimit({ timeoutMs: ghTimeoutMs.value, onProgress: onLockProgress });
        if (limit.remaining < rateLimitFloor.value)
          return failedAttempt(
            'rate-limit',
            `GitHub GraphQL rate limit remaining ${limit.remaining} is below configured floor ${rateLimitFloor.value}`,
            // The pre-fetch REST check has no per-query cost; carry `cost: null`
            // so this shares the same {cost, remaining, resetAt} shape as the
            // post-fetch GraphQL rateLimit accumulated below.
            { resetAt: limit.resetAt, remaining: limit.remaining, cost: null },
          );
      }
      // A small all-PR local watch list is an independent, bounded universe.
      // It never asks GitHub for issues; null aliases flow into normal missing
      // detection because the selected PR numbers remain absent from `pr`.
      if (economicalWatch) {
        const prFetch = watches.length
          ? fetchPRsByNumber(
              repo,
              watches.map((entry) => entry.number),
              {
                timeoutMs: ghTimeoutMs.value,
                onProgress: onLockProgress,
              },
            )
          : { rows: [], rateLimit: null };
        current = { pr: prFetch.rows, issue: [] };
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, prFetch.rateLimit);
      } else {
        const prFetch = entitySelection.wantsPr
          ? fetchPRs(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined;
        const issueFetch = entitySelection.wantsIssue
          ? fetchIssues(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined;
        current = { pr: prFetch?.rows, issue: issueFetch?.rows };
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, prFetch?.rateLimit);
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, issueFetch?.rateLimit);
      }
    } catch (err) {
      return failedAttempt('github', err);
    }
    let baseline, deltas, snapshot, rawDeltas;
    const watchTerminalIgnoresToRecord = [];
    let filteredDeltas = 0;
    const ignoreAuthorsWarnings = [];
    try {
      ({ baseline, deltas, snapshot } = detectDeltas(old, current, {
        emitBaselineState: values['baseline-emit-state'],
        at,
        staleAfterMs: staleAfter?.ms,
      }));
      // Attach the content-addressed id (and repo) here: detect.mjs is
      // repo-agnostic, but both are scoped by repo. Rebuild each delta with
      // `id` first so the dedupe key leads the serialized object; `repo` is
      // always present on a delta now, single-repo included.
      deltas = deltas.map((d) => ({ id: deltaId(deltaIdentity(repo, d)), repo, ...d }));
      // Apply --number scope before any enrichment (including the
      // --ignore-authors thread-reply fetch below): a delta outside the
      // requested selection should never spend fetch quota or produce a
      // warning naming it, since it will be dropped from the final report
      // regardless.
      if (selectedNumbers)
        deltas = deltas.filter((delta) =>
          selectedNumbers.has(
            typeof [...selectedNumbers][0] === 'string'
              ? `${delta.entity}:${delta.number}`
              : delta.number,
          ),
        );
      // Detect, BEFORE attention filtering can drop a delta entirely, any
      // watched item whose terminal transition this tick the current
      // --ignore-classes/--only-classes would suppress -- see
      // watchedTerminalTransitionFilteredThisTick's doc comment for why this
      // must run here rather than in the cleanup loop below, which only ever
      // sees post-filter survivors.
      for (const delta of deltas) {
        const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
        if (
          watchedTerminalTransitionFilteredThisTick(delta, watched, {
            onlyClasses: onlyClasses.classes,
            ignoreClasses: ignoreClasses.classes,
          })
        )
          watchTerminalIgnoresToRecord.push(watched);
      }
      if (attentionFiltering) {
        // summary/changed are always-on now; enrich before the settled
        // predicate so `filtered.summary` is available for it, then render
        // only the surviving deltas so display fields match filtered classes.
        for (const d of deltas) enrichDelta(d, {});
        const attention = applyAttentionFilters(deltas, {
          onlyClasses: onlyClasses.classes,
          ignoreClasses: ignoreClasses.classes,
          settled: false,
        });
        deltas = attention.deltas;
        filteredDeltas = attention.filteredDeltas;
        if (ignoreAuthors.authors.length) {
          const doubleOptIn = enrichmentSelection.kinds.includes('thread-replies');
          const threadReplyRows = new Map();
          for (const delta of deltas) {
            if (!delta.classes.includes('review-comments-added')) continue;
            if (!doubleOptIn) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}) carries review-comments-added but --enrich thread-replies is not set; cannot verify reply authors, failing open`,
              });
              continue;
            }
            const increments = threadReplyIncrements(
              fpOf(delta.from)?.threads,
              fpOf(delta.to)?.threads,
            );
            // threadReplyIncrements only names threads present on both sides of
            // the tick (see its doc comment in lib/detect.mjs); a thread opened
            // this same tick has no `from` baseline and is silently excluded.
            // When one or more such brand-new threads make up part (or all) of
            // the observed reviewComments rise, the increments we DID find can
            // never cover the whole rise -- verifying only the covered slice and
            // suppressing on it would silently drop a delta that may be hiding
            // an unaccounted, possibly human, reply in the uncovered remainder.
            // Require full coverage before trusting the fetched rows at all;
            // anything less is exactly as unverifiable as the !doubleOptIn case
            // above and warns the same way.
            const observedRise =
              (fpOf(delta.to)?.reviewComments ?? NaN) - (fpOf(delta.from)?.reviewComments ?? NaN);
            const covered = increments.reduce((sum, entry) => sum + entry.increment, 0);
            if (!(covered >= observedRise)) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}) carries review-comments-added but only ${covered} of ${observedRise} new review comment(s) are attributable to a thread with a prior baseline; cannot verify reply authors, failing open`,
              });
              continue;
            }
            try {
              // The one documented exception to "opt-in enrichment quota is spent
              // only after publication": this call is scoped to the filter decision
              // only (its rows feed authorsIgnored above, never delta.enrichment)
              // and its own quota is accounted in tickRateLimit like any other
              // fetch. A delta that survives filtering is still eligible for the
              // normal post-publish --enrich thread-replies pass below, which
              // re-fetches independently -- this pass never populates
              // delta.enrichment itself.
              const { rows, rateLimit: callRateLimit } = fetchThreadRepliesGh(increments, {
                timeoutMs: ghTimeoutMs.value,
                onProgress: onLockProgress,
              });
              tickRateLimit = accumulateTickRateLimit(tickRateLimit, callRateLimit);
              threadReplyRows.set(delta.id, rows);
            } catch (err) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}): ${String(err?.message ?? err)}; failing open`,
              });
            }
          }
          const authorFiltered = deltas.map((delta) =>
            authorsIgnored(delta, ignoreAuthors.authors, { threadReplyRows }),
          );
          deltas = authorFiltered.map(({ delta }) => delta).filter(Boolean);
          // A class removal on a surviving delta is not a filtered delta.
          filteredDeltas += authorFiltered.filter(({ delta }) => delta == null).length;
        }
        if (values.settled) {
          const settled = applyAttentionFilters(deltas, {
            onlyClasses: [],
            ignoreClasses: [],
            settled: true,
          });
          deltas = settled.deltas;
          filteredDeltas += settled.filteredDeltas;
        }
        for (const d of deltas) {
          enrichDelta(d, {
            summaryLine: values['summary-line'] || values.detail,
            details: values.detail,
          });
        }
      } else {
        for (const d of deltas) {
          enrichDelta(d, {
            summaryLine: values['summary-line'] || values.detail,
            details: values.detail,
          });
        }
      }
      // Public contract: delta.from/delta.to are the bare compared fingerprint,
      // not the full {fingerprint, context, meta} snapshot item -- context is
      // already its own top-level delta field (never duplicated under to/from),
      // and delta.id already hashes exactly to.fingerprint (see deltaIdentity),
      // so this makes `to` what the id actually hashes. Every internal
      // consumer that needed the full item (detail builders, diffFingerprint,
      // deltaSummary via enrichDelta, above) has already run; strip here,
      // once, before this shape reaches the durable log, enrichment, outpost,
      // and the report. deltaSummary() itself still takes a full-item `to`
      // (see lib/summary.mjs) -- its other caller, snapshotSummaryMatches()
      // below, synthesizes one from a fresh snapshot read. Any code reading a
      // delta AFTER this strip (report.deltas, the durable log, --from-log)
      // must use the already-computed `delta.summary`, never call
      // deltaSummary(delta) again -- see waitSummaryMatches().
      for (const delta of deltas) {
        delta.from = delta.from?.fingerprint ?? null;
        delta.to = delta.to?.fingerprint ?? null;
      }
      // Kept as a separate reference (not stripped) so enrichment below, which
      // runs after snapshot publication, can still find the persisted
      // identities (reviews/recentComments/...) it needs to fetch bodies.
      rawDeltas = deltas;
    } catch (err) {
      return failedAttempt('github', err);
    }

    // The fence: immediately before writing, re-verify the lock still names
    // our token. If ownership was lost during the fetch (the lock expired
    // and was stolen), fail with `busy` and write nothing -- see lib/lock.mjs
    // and docs/contract.md for the residual race this narrows but does not close.
    if (!assertLockOwned(stateFile, lockToken, lockDeps)) {
      return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
    }

    if (values.log && deltas.length > 0) {
      try {
        // The same snapshot lock serializes producers. Do not move this after
        // snapshot publication: a durable log record must precede the state
        // that makes its delta unrepeatable.
        const { fromSeq } = appendDeltaLog(
          logFile,
          // Shallow-copy each delta: enrichment (below) mutates `delta.enrichment`
          // on these same objects in place once opted in, and the durable log
          // must stay the pre-enrichment public stream regardless of object
          // identity, not only regardless of the bytes already on disk.
          { detectedAt: at, deltas: deltas.map((delta) => ({ ...delta })), repo, monitorId },
          {
            // Renew at the log-mutation boundary, then let deltalog fence each
            // destructive write after its own scan/serialization work. This is
            // the log equivalent of snapshot.mjs's verifyBeforeCommit fence.
            onProgress: () =>
              extendLockDeadline(stateFile, lockToken, {
                ghTimeoutMs: ghTimeoutMs.value,
                ...lockDeps,
              }),
            verifyBeforeMutation: () => assertLockOwned(stateFile, lockToken, lockDeps),
          },
        );
        // Stamp the journal record number onto each delta object BEFORE
        // enrichment runs (below) and before report assembly reads `deltas`.
        // `deltas` and `rawDeltas` are the same array reference in the same
        // order appendDeltaLog just wrote, so record i's seq is fromSeq + i --
        // this must stay index-aligned with the exact array appendDeltaLog
        // consumed, not a copy or a re-sorted view of it.
        deltas.forEach((delta, index) => {
          delta.seq = fromSeq + index;
        });
      } catch (err) {
        if (err?.code === 'LOCK_LOST') {
          return failedAttempt('busy', `lock lost before delta log write: ${stateFile}`);
        }
        return failedAttempt(err?.kind === 'log' ? 'log' : 'io', err);
      }
      if (!assertLockOwned(stateFile, lockToken, lockDeps)) {
        return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
      }
    }

    try {
      // Self-describing snapshot: identity travels in the data, not only in the
      // derived filename, so `list` can recognize --state-file snapshots too.
      // verifyBeforeCommit re-runs the same ownership check immediately before
      // writeSnapshotAtomic's final renameSync -- the earlier assertLockOwned
      // check above is cheaper (fails before the JSON serialize/temp-write
      // work), but this is the one that actually shrinks the residual race to
      // a single syscall gap. See lib/lock.mjs and docs/contract.md.
      writeSnapshotAtomic(
        stateFile,
        {
          ...snapshot,
          meta: {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            ghDeltaVersion: getPackageMetadata().version,
            repo,
            monitorId,
            entities: economicalWatch ? ['pr'] : entitySelection.selected,
            scope: economicalWatch ? 'watch-pr' : 'poll',
            horizon: at,
            createdAt: old?.meta?.createdAt ?? at,
            updatedAt: at,
          },
        },
        {
          ...(usedDefaultDir ? { dirMode: 0o700 } : {}),
          verifyBeforeCommit: () => assertLockOwned(stateFile, lockToken, lockDeps),
        },
      );
    } catch (err) {
      if (err?.code === 'LOCK_LOST') {
        return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
      }
      return failedAttempt('io', err);
    }
    registerAttempt('ok');
    const cleanupWarnings = [];
    for (const delta of deltas) {
      const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
      // Schema v2 lowercases every enum at fetch time (lib/gh.mjs), so the
      // terminal test reads `open`/`merged`, not v1's `OPEN`/`MERGED`.
      const state = delta.to?.state;
      // `state` decides what "terminal" MEANS (a merged PR never reaches
      // `closed` -- see lib/detect.mjs's classifyPr -- so `--until closed`
      // must still recognize `merged` as terminal, per #57).
      // `isTerminalCleanupEligible` decides whether THIS delta may act on
      // that -- see its doc comment for the four-case distinction. Marking
      // a watch entry as having had a transition ignored is handled
      // entirely by watchTerminalIgnoresToRecord above, before filtering
      // ran: it already covers this delta whether its terminal class was
      // fully dropped or survived alongside another class (e.g. a same-tick
      // merge+relabel), so there is nothing left to mark here.
      const cleanupEligible =
        watched &&
        isTerminalCleanupEligible(delta, watched.entry, {
          onlyClasses: onlyClasses.classes,
          ignoreClasses: ignoreClasses.classes,
        });
      if (
        watched &&
        cleanupEligible &&
        ((watched.entry.until === 'merged' && state === 'merged') ||
          (watched.entry.until === 'closed' && state !== 'open'))
      ) {
        try {
          removeWatchedFile(watched.path, watched.bytes);
        } catch (err) {
          cleanupWarnings.push({ label: 'watch cleanup', reason: String(err.message ?? err) });
        }
      }
    }
    for (const watched of watchTerminalIgnoresToRecord) {
      try {
        markWatchTerminalIgnored(watched.path, watched.bytes, at);
      } catch (err) {
        cleanupWarnings.push({ label: 'watch cleanup', reason: String(err.message ?? err) });
      }
    }
    // This is intentionally after the atomic snapshot publish.  A failed
    // publication therefore cannot spend opt-in quota, and the durable log
    // above remains a replayable pre-enrichment record.
    const enrichmentResult = enrichmentSelection.kinds.length
      ? enrichEmittedDeltas(rawDeltas, enrichmentSelection.kinds, {
          fetch: (kind, ids) =>
            kind === 'thread-replies'
              ? fetchThreadRepliesGh(ids, {
                  timeoutMs: ghTimeoutMs.value,
                  onProgress: onLockProgress,
                })
              : fetchEnrichment(kind, ids, {
                  timeoutMs: ghTimeoutMs.value,
                  onProgress: onLockProgress,
                }),
        })
      : { warnings: [], rateLimit: null };
    const enrichmentWarnings = enrichmentResult.warnings;
    tickRateLimit = accumulateTickRateLimit(tickRateLimit, enrichmentResult.rateLimit);
    const summary = baseline
      ? `baseline established: ${Object.keys(snapshot.pr).length} PRs, ${Object.keys(snapshot.issue).length} issues${
          deltas.length ? `; ${deltas.length} baseline-state delta(s)` : ''
        }`
      : `${deltas.length} delta(s)`;
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      baseline,
      repo,
      repoSource,
      monitorId,
      entities: entitySelection.selected,
      stateFile,
      ...(values.log ? { logFile } : {}),
      at,
      deltas,
      filteredDeltas,
      summary,
    };
    const warnings = [
      ...derivationWarnings,
      ...(lockWarning ? [lockWarning] : []),
      ...monitorIdentityWarnings(),
      ...cleanupWarnings,
      ...enrichmentWarnings,
      ...ignoreAuthorsWarnings,
    ];
    return {
      // A baseline normally exits 0 with empty deltas; --baseline-emit-state makes
      // it emit baseline-state deltas, and any run with deltas exits 10. Since only
      // that flag can pair baseline === true with a non-empty deltas array, this
      // stays byte-identical to `baseline || deltas.length === 0 ? 0 : 10` on every
      // pre-existing path.
      code: deltas.length === 0 ? 0 : 10,
      report,
      format,
      warnings,
      // Internal-only, not part of `report`: the tick's accumulated GraphQL
      // quota spend (observation fetches above + enrichment above). Sibling
      // to `report` deliberately -- buildDetectorReport (below) is what
      // surfaces it as `results[].rateLimit` in the public report envelope.
      rateLimit: tickRateLimit,
    };
  } finally {
    // Every exit path from the try block above -- success or any thrown/
    // returned error -- releases the lock. releaseLock is a no-op if our
    // token no longer matches (ownership already lost; see the fence above).
    releaseLock(stateFile, lockToken, lockDeps);
  }
}

// Keep `run` as the public entrypoint.  The historical implementation above is
// deliberately kept as one complete, private repository tick: calling it once
// is therefore byte-for-byte the old path, while the small wrapper below can
// serialize several independent ticks without ever holding several locks.
function explicitRepos(argv) {
  const values = [];
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--repo') {
      if (index + 1 >= argv.length) return { malformed: true };
      values.push(argv[++index]);
    } else if (arg.startsWith('--repo=')) {
      values.push(arg.slice('--repo='.length));
    } else {
      rest.push(arg);
    }
  }
  if (!values.length) return { repos: [], rest: argv };
  const repos = [];
  for (const value of values) {
    for (const member of String(value).split(',')) {
      const candidate = member.trim();
      if (!candidate)
        return {
          error: `--repo must be a comma-separated list of owner/name values; got "${value}"`,
        };
      const validated = validateRepo(candidate);
      if (!validated.ok) return { error: validated.error };
      if (!repos.includes(validated.repo)) repos.push(validated.repo);
    }
  }
  return { repos, rest };
}

function aggregateError(argv, deps, message) {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const parsed = parseCli(argv);
  const monitorId = parsed.values
    ? selectedMonitorId(
        parsed.values,
        deps.env ?? process.env,
        deps.defaultMonitor ?? defaultMonitorId,
      )
    : undefined;
  return errorResult('config', message, { ...(monitorId ? { monitorId } : {}), at }, parsed.format);
}

// Shared validation is repeated here rather than probing a real tick: a probe
// could create a state directory or acquire a lock before a later config error.
function multiConfigError(values, env, defaultMonitor) {
  const timeout = positiveInt('--gh-timeout-ms', values['gh-timeout-ms']);
  if (timeout.error) return timeout.error;
  const floor =
    values['rate-limit-floor'] === undefined
      ? null
      : nonNegativeSafeInt('--rate-limit-floor', values['rate-limit-floor']);
  if (floor?.error) return floor.error;
  const stale = parseDuration(values['lock-stale-ms'], { flag: '--lock-stale-ms' });
  if (stale.error) return stale.error;
  const monitor = validateMonitorId(selectedMonitorId(values, env, defaultMonitor));
  if (!monitor.ok) return monitor.error;
  if (values['state-file'] && values['state-dir'])
    return '--state-file and --state-dir are mutually exclusive';
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok) return `--entities must include pr, issue, or both; got "${values.entities}"`;
  if (values['watch-dir'] !== undefined && values.number !== undefined)
    return '--watch-dir and --number are mutually exclusive';
  const numbers = watchNumbers(values.number);
  if (!numbers.ok) return numbers.error;
  for (const [flag, value] of [
    ['--only-classes', values['only-classes']],
    ['--ignore-classes', values['ignore-classes']],
  ]) {
    const selection = parseDeltaClassSelection(flag, value);
    if (!selection.ok) return selection.error;
  }
  const authors = parseIgnoreAuthors(values['ignore-authors']);
  if (!authors.ok) return authors.error;
  const enrich = parseEnrichmentSelection(values.enrich);
  if (!enrich.ok) return enrich.error;
  if (!['json', 'text', 'compact', 'ndjson'].includes(values.format))
    return '--format must be json, text, compact, or ndjson';
  if (values['outpost-url'] !== undefined) {
    const url = validateOutpostUrl(values['outpost-url']);
    if (!url.ok) return url.error;
  }
  if (values['outpost-secret'] !== undefined) {
    const name = values['outpost-secret'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return '--outpost-secret must name an environment variable matching [A-Za-z_][A-Za-z0-9_]*';
    if (values['outpost-url'] === undefined) return '--outpost-secret requires --outpost-url';
    if (typeof env[name] !== 'string' || env[name].length === 0)
      return `environment variable ${name} for --outpost-secret is unset or empty`;
  }
  const outpostTimeout = positiveInt('--outpost-timeout-ms', values['outpost-timeout-ms']);
  if (outpostTimeout.error) return outpostTimeout.error;
  if (values['outpost-max-posts'] !== undefined) {
    const max = positiveInt('--outpost-max-posts', values['outpost-max-posts']);
    if (max.error) return max.error;
  }
  return null;
}

// Build the unified detector report envelope from one or more completed
// per-repo runSingle results. Every detector-tick invocation that knows its
// repo(s) -- 0, 1, or many explicit --repo -- funnels through this, so
// single- and multi-repo runs share one report shape: `repos`/`results` are
// always arrays, per-repo failures live only in `results[i].error` (never a
// top-level `errors`), and `filteredDeltas`/`warnings` are always present.
function buildDetectorReport(pairs, { now }) {
  const multi = pairs.length > 1;
  const results = pairs.map(({ repo, result }) => {
    const r = result.report;
    return {
      repo,
      baseline: r.baseline ?? false,
      repoSource: r.repoSource,
      stateFile: r.stateFile,
      ...(r.logFile ? { logFile: r.logFile } : {}),
      rateLimit: result.rateLimit ?? null,
      ...(r.error
        ? {
            error: {
              kind: r.kind,
              message: r.error,
              hint: r.hint,
              ...(r.resetAt ? { resetAt: r.resetAt } : {}),
              ...(r.remaining !== undefined ? { remaining: r.remaining } : {}),
              ...(r.cost !== undefined && r.cost !== null ? { cost: r.cost } : {}),
            },
          }
        : {}),
    };
  });
  const deltas = pairs.flatMap(({ repo, result }) =>
    (result.report.deltas ?? []).map((delta) => ({ ...delta, repo })),
  );
  const filteredDeltas = pairs.reduce(
    (sum, { result }) => sum + (result.report.filteredDeltas ?? 0),
    0,
  );
  const warnings = pairs.flatMap(({ repo, result }) =>
    (result.warnings ?? []).map((warning) =>
      multi ? { ...warning, label: `${repo}: ${warning.label}` } : warning,
    ),
  );
  // The exit code walks `results[]` (via `pairs`, its source of truth): any
  // permanent (exit 2) per-repo failure wins outright, else any failure at
  // all downgrades to exit 1, else the usual 0/10 delta-presence split.
  const anyPermanent = pairs.some(({ result }) => result.report.error && result.code === 2);
  const anyError = pairs.some(({ result }) => result.report.error);
  const code = anyPermanent ? 2 : anyError ? 1 : deltas.length ? 10 : 0;
  const repos = pairs.map(({ repo }) => repo);
  const summary = multi
    ? `${deltas.length} delta(s) across ${repos.length} repo(s); ${results.filter((row) => row.error).length} error(s)`
    : (pairs[0].result.report.summary ??
      (results[0]?.error ? `error: ${results[0].error.message}` : `${deltas.length} delta(s)`));
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    detectedAt: now(),
    monitorId: pairs[0].result.report.monitorId,
    entities: pairs[0].result.report.entities,
    repos,
    results,
    deltas,
    filteredDeltas,
    warnings,
    summary,
  };
  return { code, report, format: pairs[0].result.format, warnings };
}

/** Execute zero or more fully isolated repository ticks, serially. */
export function run(argv, deps = {}) {
  // Configuration is deliberately applied only to detector ticks. Subcommands
  // have narrower grammars and remain explicit/readable instead of inheriting
  // unrelated detector flags (for example --log on `list`).
  if (
    !deps.__configApplied &&
    ![
      'watch',
      'log',
      'list',
      'read',
      'cursor',
      'schema',
      'status',
      'wait',
      'init',
      'doctor',
      'explain',
      'demo',
      'reset',
    ].includes(argv[0]) &&
    !argv.includes('--help') &&
    !argv.includes('--help-json') &&
    !argv.includes('--version')
  ) {
    const configured = applyConfig(argv, configDeps(deps));
    if (!configured.ok)
      return errorResult(
        'config',
        configured.error,
        { at: (deps.now ?? (() => new Date().toISOString()))() },
        formatSniff(argv),
      );
    argv = configured.argv;
  }
  // Subcommands retain their independent grammar, including a single --repo.
  if (
    [
      'watch',
      'log',
      'list',
      'read',
      'cursor',
      'schema',
      'status',
      'init',
      'doctor',
      'explain',
      'demo',
      'reset',
    ].includes(argv[0])
  )
    return runSingle(argv, deps);
  // Help/version are deliberately an indestructible literal pre-scan; preserve
  // that promise even when a prospective multi-repo value is malformed.
  if (argv.includes('--help') || argv.includes('--help-json') || argv.includes('--version'))
    return runSingle(argv, deps);
  const selected = explicitRepos(argv);
  if (selected.malformed || selected.error) {
    return aggregateError(argv, deps, selected.error ?? 'option --repo argument is missing');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  // 0 or 1 explicit --repo: one tick. Its report still funnels through the
  // shared repos/results envelope below (schema v2 unifies single- and
  // multi-repo shapes) UNLESS the tick never got as far as knowing its repo
  // (a pre-flight config error, or `resolveRepo` itself failing) -- that bare
  // shape is returned untouched, matching every other subcommand's error report.
  if (selected.repos.length <= 1) {
    const tickArgv =
      selected.repos.length === 1 ? [...selected.rest, '--repo', selected.repos[0]] : argv;
    const result = runSingle(tickArgv, deps);
    if (result.report?.repo === undefined) return result;
    return buildDetectorReport([{ repo: result.report.repo, result }], { now });
  }
  if (selected.rest.some((arg) => arg === '--state-file' || arg.startsWith('--state-file='))) {
    return aggregateError(
      argv,
      deps,
      '--state-file cannot be used with multiple repositories; use --state-dir or derived state paths',
    );
  }
  // Parse shared grammar before the first tick. This catches malformed flags
  // before locks, snapshots, registries, or GitHub are touched.
  const oneArgv = [...selected.rest, '--repo', selected.repos[0]];
  const parsed = parseCli(oneArgv);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return aggregateError(argv, deps, parsed.error);
  const configError = multiConfigError(
    parsed.values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  if (configError) return aggregateError(argv, deps, configError);
  if (parsed.values['watch-dir'] !== undefined) {
    let entries;
    try {
      entries = readWatch(parsed.values['watch-dir']);
    } catch (err) {
      return aggregateError(argv, deps, String(err?.message ?? err));
    }
    const effective = new Set();
    for (const entry of entries) {
      if (entry.repo !== undefined && !validateRepo(entry.repo).ok)
        return aggregateError(argv, deps, `invalid watch entry repository ${entry.repo}`);
      const target = entry.repo ?? selected.repos[0];
      // Entries for a different selected universe are intentionally inert.
      if (!selected.repos.includes(target)) continue;
      const key = `${target}:${entry.entity}:${entry.number}`;
      if (effective.has(key))
        return aggregateError(argv, deps, `duplicate effective watch entry ${key}`);
      effective.add(key);
    }
  }

  const pairs = selected.repos.map((repo, index) => ({
    repo,
    result: runSingle([...selected.rest, '--repo', repo], { ...deps, __multiRepoIndex: index }),
  }));
  return buildDetectorReport(pairs, { now });
}

/**
 * Run the detector and optionally deliver one outpost event per delta.
 *
 * Outpost validation happens before GitHub fetches (inside `run`). Delivery
 * happens after the snapshot write and returns warnings instead of changing
 * the detector code.
 */
export async function runWithOutpost(argv, deps = {}) {
  const { outpostFetch = globalThis.fetch, env = process.env } = deps;
  const isDetectorTick =
    ![
      'watch',
      'log',
      'list',
      'read',
      'cursor',
      'schema',
      'status',
      'wait',
      'init',
      'doctor',
      'explain',
      'demo',
      'reset',
    ].includes(argv[0]) &&
    !argv.includes('--help') &&
    !argv.includes('--help-json') &&
    !argv.includes('--version');
  const configured = isDetectorTick ? applyConfig(argv, configDeps(deps)) : { ok: true, argv };
  const effectiveArgv = configured.ok ? configured.argv : argv;
  const result = run(effectiveArgv, { ...deps, __configApplied: configured.ok });
  const outpostUrl = parseCli(effectiveArgv).values?.['outpost-url'];
  if (!outpostUrl || !result.report?.deltas?.length || typeof result.report === 'string') {
    return { ...result, warnings: result.warnings ?? [] };
  }
  const values = parseCli(effectiveArgv).values ?? {};
  const secret = values['outpost-secret'] === undefined ? undefined : env[values['outpost-secret']];
  const timeoutMs = deps.outpostTimeoutMs ?? Number(values['outpost-timeout-ms'] ?? 4000);
  const maxPosts =
    deps.outpostMaxPosts ??
    (values['outpost-max-posts'] !== undefined ? Number(values['outpost-max-posts']) : Infinity);
  const validated = validateOutpostUrl(outpostUrl);
  const { warnings } = await sendOutposts({
    outpostUrl: validated.url,
    report: result.report,
    fetchImpl: outpostFetch,
    timeoutMs,
    maxPosts,
    secret,
  });
  return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
}

/**
 * Run the public CLI command and return process-ready stdout/stderr strings.
 */
export async function runCommand(argv, deps = {}) {
  let effectiveArgv = argv;
  if (
    argv[0] === 'wait' &&
    !argv.includes('--help') &&
    !argv.includes('--help-json') &&
    !argv.includes('--version')
  ) {
    const configured = applyConfig(argv.slice(1), configDeps(deps));
    if (!configured.ok) {
      const result = errorResult(
        'config',
        configured.error,
        { at: (deps.now ?? (() => new Date().toISOString()))(), command: 'wait' },
        formatSniff(argv),
      );
      return { ...result, output: `${JSON.stringify(result.report, null, 2)}\n`, stderr: '' };
    }
    effectiveArgv = ['wait', ...configured.argv];
  }
  const result =
    effectiveArgv[0] === 'wait'
      ? await runWait(effectiveArgv.slice(1), deps)
      : await runWithOutpost(effectiveArgv, deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const format = result.format ?? 'json';

  if (format === 'schema') {
    return { ...result, output: `${JSON.stringify(result.report, null, 2)}\n`, stderr: '' };
  }

  if (format === 'compact') {
    const report = compactReport(result.report, result.code, result.warnings ?? [], {
      detail: effectiveArgv.includes('--detail'),
      full: effectiveArgv.includes('--full'),
    });
    return {
      ...result,
      output: `${JSON.stringify(report, null, 2)}\n`,
      stderr: deps.onProgress ? '' : (result.progress ?? ''),
    };
  }

  if (format === 'ndjson') {
    return {
      ...result,
      output: ndjsonReport(result.report, result.code, result.warnings ?? [], {
        detail: effectiveArgv.includes('--detail'),
        full: effectiveArgv.includes('--full'),
      }),
      stderr: deps.onProgress ? '' : (result.progress ?? ''),
    };
  }

  if (format === 'text') {
    const body =
      result.report?.command === 'doctor'
        ? formatDoctorTextOutput({ report: result.report })
        : result.report?.command === 'init'
          ? formatInitTextOutput({ report: result.report })
          : result.report?.command === 'explain'
            ? formatExplainTextOutput({ report: result.report })
            : result.report?.command === 'demo'
              ? formatDemoTextOutput({ report: result.report })
              : result.report?.command === 'list'
                ? formatListTextOutput({ report: result.report })
                : result.report?.command === 'status'
                  ? formatStatusTextOutput({ report: result.report, now })
                  : result.report?.command?.startsWith('watch ')
                    ? formatWatchTextOutput({ report: result.report })
                    : result.report?.command === 'read'
                      ? formatReadTextOutput({ code: result.code, report: result.report, now })
                      : result.report?.command === 'log compact'
                        ? formatCompactTextOutput({ report: result.report, now })
                        : result.report?.command === 'cursor set'
                          ? formatCursorSetTextOutput({ report: result.report, now })
                          : result.report?.command === 'reset'
                            ? formatResetTextOutput({ report: result.report, now })
                            : formatTextOutput({ code: result.code, report: result.report, now });
    return {
      ...result,
      output: `${body}${formatOutpostWarnings(result.warnings)}\n`,
      stderr: deps.onProgress ? '' : (result.progress ?? ''),
    };
  }

  const report =
    typeof result.report === 'string' || !result.warnings?.length
      ? result.report
      : { ...result.report, warnings: result.warnings };
  return {
    ...result,
    output: typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
    stderr: deps.onProgress ? '' : (result.progress ?? ''),
  };
}
