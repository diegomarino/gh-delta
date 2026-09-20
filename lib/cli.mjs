// CLI orchestration seam. Chains the pure and boundary modules into one tick:
// args -> snapshot read -> GitHub fetch -> delta detection -> snapshot write ->
// optional outpost delivery -> report. Keeps every side effect at this layer so
// detect/fingerprint stay pure and independently testable.
import { parseArgs } from 'node:util';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './gh.mjs';
import { detectDeltas, threadSetDiff } from './detect.mjs';
import { ADDITIVE_COMPARED_FIELDS, deltaId, deltaIdentity } from './fingerprint.mjs';
import { deltaSummary } from './summary.mjs';
import {
  defaultStateDir,
  horizonCutoff,
  readSnapshot as fsRead,
  snapshotPath,
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
  validateMonitorId,
  validateRepo,
} from './args.mjs';
import { parseDuration } from './duration.mjs';
import {
  addWatch,
  listWatch,
  readWatch,
  removeWatch,
  removeWatchUnchanged,
  watchDirPath,
} from './watch.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import {
  formatCompactTextOutput,
  formatCursorSetTextOutput,
  formatListTextOutput,
  formatOutpostWarnings,
  formatReadTextOutput,
  formatTextOutput,
} from './text-output.mjs';
import { renderVersionText } from './version.mjs';
import { DELTA_CLASSES, REPORT_SCHEMA_VERSION } from './contract.mjs';
import { resolveRepoFromGit } from './repo-source.mjs';
import {
  appendDeltaLog as fsAppendDeltaLog,
  compactDeltaLog as fsCompactDeltaLog,
  deltaLogPath,
  readCursor as fsReadCursor,
  readDeltaLog as fsReadDeltaLog,
  setCursorAtomic as fsSetCursorAtomic,
} from './deltalog.mjs';

// Version of the machine-readable detector report shape. Bumped only on a
// breaking change (a field removed or renamed). Additive fields -- new optional
// keys on the report, a delta, or a fingerprint -- do not bump it. Consumers can
// assert `report.schemaVersion === 1` on every JSON response, success or error.
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
  return `${d.entity.toUpperCase()} #${d.number} "${d.title}": ${d.classes.join(', ')}`;
}

function hasField(value, field) {
  return value != null && Object.hasOwn(value, field);
}

function fieldDetail(klass, field, from, to, extra = {}) {
  return Object.fromEntries(
    Object.entries({ class: klass, field, from, to, ...extra }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function pushFieldDetail(details, klass, delta, field, extra = {}) {
  if (!hasField(delta.from, field) && !hasField(delta.to, field)) return;
  const from = hasField(delta.from, field) ? delta.from[field] : null;
  const to = hasField(delta.to, field) ? delta.to[field] : null;
  if (JSON.stringify(from) === JSON.stringify(to)) return;
  details.push(fieldDetail(klass, field, from, to, extra));
}

function pushNumericDelta(details, klass, delta, field) {
  if (!hasField(delta.from, field) || !hasField(delta.to, field)) return;
  const from = delta.from[field];
  const to = delta.to[field];
  if (from === to) return;
  const extra = { delta: to - from };
  if (klass === 'new-comments') {
    const added = delta.to?.commentNodes;
    const conversationIncrement =
      (delta.to?.conversationComments ?? NaN) - (delta.from?.conversationComments ?? NaN);
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
  details.push(fieldDetail(klass, field, from, to, extra));
}

// Set-style detail for sorted string-list fingerprint fields (labels,
// assignees, reviewRequests): name what entered and what left.
function pushSetDelta(details, klass, delta, field) {
  const from = hasField(delta.from, field) ? delta.from[field] : [];
  const to = hasField(delta.to, field) ? delta.to[field] : [];
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
// the only detail row that names the affected threads. Guarded (via
// `threadSetDiff`) on both sides carrying `threadStates`, and omitted entirely
// when there is nothing to name (a legacy snapshot, or a class that fired
// purely from the counter moving with no identity-level swap).
function pushThreadSetDelta(details, klass, delta) {
  const { addedIds, removedIds } = threadSetDiff(delta.from?.threadStates, delta.to?.threadStates);
  if (addedIds.length === 0 && removedIds.length === 0) return;
  details.push({ class: klass, field: 'threadStates', added: addedIds, removed: removedIds });
}

function changedFingerprintFields(delta) {
  if (!delta.from || !delta.to) return [];
  const keys = new Set([...Object.keys(delta.from), ...Object.keys(delta.to)]);
  return [...keys]
    .filter(
      (key) =>
        // ciChecks/reviewSummary mirror the ci/reviews digests; threadDigest/
        // threadStates mirror the thread-identity swap trigger. Surfacing any
        // of them here would only duplicate the digest transition (or invent
        // one when a pre-summary/pre-thread-identity snapshot side simply
        // lacks the field) -- their meaningful expression is the dedicated
        // detail each drives instead (ci-changed/review-changed's named
        // breakdown, unresolved-threads-added/-resolved's threadStates row).
        ![
          'missing',
          'missingTicks',
          'commentsOverflow',
          'ciChecks',
          'reviewSummary',
          'threadDigest',
          'threadStates',
        ].includes(key),
    )
    .filter(
      // Same additive-field suppression as the detector's change comparison: a
      // compared field the old snapshot predates is not a transition, so an
      // upgrade tick must not report a phantom `null -> current` detail row.
      (key) => !(ADDITIVE_COMPARED_FIELDS.includes(key) && !Object.hasOwn(delta.from, key)),
    )
    .filter((key) => JSON.stringify(delta.from[key]) !== JSON.stringify(delta.to[key]))
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

// Build the extra detail keys for an opaque-digest transition (ci/reviews).
// When both fingerprint sides carry the persisted normalized summary, name the
// exact entries that changed so an agent can act without re-querying GitHub.
// Otherwise (a snapshot written before summaries existed, duplicate keys, or a
// diff the summary cannot explain) fall back to marking the digest transition
// `opaque: true`.
function summaryDiffExtra(delta, summaryField, key) {
  const from = delta.from?.[summaryField];
  const to = delta.to?.[summaryField];
  if (!Array.isArray(from) || !Array.isArray(to)) return { opaque: true };
  const diff = diffSummaries(from, to, key);
  if (!diff || (!diff.added.length && !diff.removed.length && !diff.changed.length)) {
    return { opaque: true };
  }
  const detailField = summaryField === 'ciChecks' ? 'ciDetails' : 'reviewDetails';
  const withDetail = (row) => {
    const source = (delta.to?.[detailField] ?? []).find(
      (candidate) =>
        candidate[key] === row[key] &&
        candidate.state === row.state &&
        candidate.status === row.status &&
        candidate.conclusion === row.conclusion &&
        candidate.submittedAt === row.submittedAt,
    );
    if (!source) return row;
    if (
      summaryField === 'ciChecks' &&
      source.detailsUrl &&
      ['FAILURE', 'TIMED_OUT', 'CANCELLED'].includes(source.conclusion)
    )
      return { ...row, detailsUrl: source.detailsUrl };
    if (summaryField === 'reviewSummary' && source.state === 'CHANGES_REQUESTED' && source.id)
      return { ...row, id: source.id };
    return row;
  };
  return {
    ...diff,
    added: diff.added.map(withDetail),
    changed: diff.changed.map((row) => {
      const enriched = withDetail({ [key]: row[key], ...row.to });
      const { [key]: _key, ...to } = enriched;
      return { ...row, to };
    }),
  };
}

// Expand one delta class into the schema's field-level `details` entries: the
// concrete from/to changes (state, labels, ci, presence, ...) a consumer needs
// to act without re-diffing the raw fingerprints. Each class maps to the fields
// it can meaningfully explain; ci/reviews digest transitions carry a named
// added/removed/changed breakdown when both sides persisted the normalized
// summary, and are marked `opaque: true` when they cannot name the change.
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
            delta.missingTicks ?? delta.from?.missingTicks ?? (klass === 'missing' ? 1 : undefined),
        }),
      );
      break;
    case 'reappeared':
      details.push(
        fieldDetail(klass, 'presence', 'missing', 'present', {
          missingTicks: delta.from?.missingTicks,
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
      pushFieldDetail(details, klass, delta, 'ci', summaryDiffExtra(delta, 'ciChecks', 'name'));
      break;
    case 'review-changed':
      pushFieldDetail(details, klass, delta, 'review');
      pushFieldDetail(
        details,
        klass,
        delta,
        'reviews',
        summaryDiffExtra(delta, 'reviewSummary', 'author'),
      );
      break;
    case 'became-mergeable':
    case 'became-conflicting':
      pushFieldDetail(details, klass, delta, 'mergeable');
      break;
    case 'base-changed':
      pushFieldDetail(details, klass, delta, 'base');
      break;
    case 'head-changed':
      pushFieldDetail(details, klass, delta, 'head');
      break;
    case 'new-comments':
    case 'comments-removed':
      pushNumericDelta(details, klass, delta, 'comments');
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
          field === 'ci'
            ? summaryDiffExtra(delta, 'ciChecks', 'name')
            : field === 'reviews'
              ? summaryDiffExtra(delta, 'reviewSummary', 'author')
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

function hideInternalDetails(delta) {
  const strip = (fingerprint) => {
    if (!fingerprint) return fingerprint;
    const {
      ciDetails: _ciDetails,
      reviewDetails: _reviewDetails,
      commentNodes: _commentNodes,
      conversationComments: _conversationComments,
      ...publicFingerprint
    } = fingerprint;
    return publicFingerprint;
  };
  return { ...delta, from: strip(delta.from), to: strip(delta.to) };
}

// Exported so docs tooling (tools/examples) can render fixture deltas through
// the exact same enrichment the CLI uses, keeping example artifacts faithful.
export function enrichDelta(
  delta,
  { summaryLine = false, legacyLine = false, details = false, summaries = false },
) {
  const rendered = line(delta);
  if (summaryLine) delta.summaryLine = rendered;
  if (legacyLine) delta.line = rendered;
  if (details) delta.details = detailDelta(delta);
  // Optional semantic layer. Attached only for PR deltas with an observed `to`
  // state (deltaSummary returns null otherwise). It is a SIBLING of `to`, never
  // nested inside it, so the content-addressed delta.id -- which hashes `to` --
  // stays byte-identical whether or not summaries are requested.
  if (summaries) {
    const summary = deltaSummary(delta);
    if (summary) delta.summary = summary;
  }
}

// Permanent errors exit 2; transient errors exit 1. `busy` (state-file lock
// held or unresolvable) is transient: the next tick retries.
const ERROR_EXIT_CODES = { config: 2, snapshot: 2, github: 1, io: 1, busy: 1, log: 2 };

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

// Build a structured error result with kind, exit code, and report.
// context holds optional { repo, monitorId, at } fields.
function errorResult(kind, error, context, format) {
  return {
    code: ERROR_EXIT_CODES[kind],
    report: { schemaVersion: REPORT_SCHEMA_VERSION, error, kind, ...context },
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

function commentAuthorsIgnored(delta, ignoredAuthors) {
  if (!ignoredAuthors?.length || !delta.classes.includes('new-comments'))
    return { delta, filtered: false };
  const increment = (delta.to?.comments ?? 0) - (delta.from?.comments ?? 0);
  const conversationIncrement =
    (delta.to?.conversationComments ?? NaN) - (delta.from?.conversationComments ?? NaN);
  const rows = delta.to?.commentNodes;
  if (
    increment <= 0 ||
    conversationIncrement !== increment ||
    !Array.isArray(rows) ||
    increment > rows.length
  )
    return { delta, filtered: false };
  const added = rows.slice(-increment);
  if (added.some((row) => !row?.id || !row?.author)) return { delta, filtered: false };
  if (!added.every((row) => ignoredAuthors.includes(row.author.toLowerCase())))
    return { delta, filtered: false };
  const classes = delta.classes.filter((klass) => klass !== 'new-comments');
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
  'only-classes': { type: 'string' },
  'ignore-classes': { type: 'string' },
  'ignore-authors': { type: 'string' },
  settled: { type: 'boolean', default: false },
  'baseline-emit-state': { type: 'boolean', default: false },
  'summary-line': { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
  'outpost-secret': { type: 'string' },
  'outpost-timeout-ms': { type: 'string', default: '4000' },
  'outpost-max-posts': { type: 'string' },
  'gh-timeout-ms': { type: 'string', default: '60000' },
  'no-registry': { type: 'boolean', default: false },
  'lock-stale-ms': { type: 'string', default: '10m' },
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
  return format === 'text' ? 'text' : 'json';
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
    ({ values } = parseArgs({ args: argv, options: WATCH_OPTIONS, allowPositionals: true }));
  } catch (err) {
    return errorResult('config', String(err), { at, command: 'watch' }, formatSniff(argv));
  }
  if (!['json', 'text'].includes(values.format))
    return errorResult('config', '--format must be json or text', { at, command: 'watch' }, 'json');
  let dir = values['watch-dir'];
  if (!dir) {
    const repo = validateRepo(values.repo);
    const id = validateMonitorId(values['monitor-id']);
    if (!repo.ok || !id.ok || !values['state-dir'])
      return errorResult(
        'config',
        '--repo, --monitor-id, and --state-dir are required without --watch-dir',
        { at, command: 'watch' },
        values.format,
      );
    dir = watchDirPath(repo.repo, id.monitorId, values['state-dir']);
  }
  try {
    const item = values.positionals?.[0];
    const result =
      action === 'add'
        ? addWatch(dir, item, values.until, { now })
        : action === 'rm'
          ? removeWatch(dir, item)
          : { entries: listWatch(dir) };
    return {
      code: 0,
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: `watch ${action}`,
        watchDir: dir,
        at,
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
export function run(argv, deps = {}) {
  if (argv[0] === 'watch') return runWatch(argv.slice(1), deps);
  if (argv[0] === 'log' && argv[1] === 'compact') return runCompact(argv.slice(2), deps);
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
    fetchIssues = ghIssues,
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
  } = deps;
  const at = now();
  const parsed = parseCli(argv);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return errorResult('config', parsed.error, { at }, parsed.format);
  const values = parsed.values;
  const format = parsed.format;
  const ghTimeoutMs = positiveInt('--gh-timeout-ms', values['gh-timeout-ms']);
  if (ghTimeoutMs.error) return errorResult('config', ghTimeoutMs.error, { at }, format);
  const lockStaleMs = parseDuration(values['lock-stale-ms'], { flag: '--lock-stale-ms' });
  if (lockStaleMs.error) return errorResult('config', lockStaleMs.error, { at }, format);
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
  const attentionFiltering =
    values['only-classes'] !== undefined ||
    values['ignore-classes'] !== undefined ||
    values['ignore-authors'] !== undefined ||
    values.settled;
  if (values.format !== 'json' && values.format !== 'text')
    return errorResult('config', '--format must be json or text', { monitorId, at }, format);
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
    try {
      watches = readWatch(effectiveWatchDir);
    } catch (err) {
      return errorResult('config', String(err.message ?? err), ids, format);
    }
    selectedNumbers = new Set(watches.map((entry) => entry.number));
    for (const entry of watches) {
      const path = join(effectiveWatchDir, `${entry.entity}-${entry.number}.json`);
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
  const usedDefaultDir = !values['state-file'] && !values['state-dir'];
  let stateFile = values['state-file'];
  if (!stateFile) {
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
    stateFile = snapshotPath(repo, monitorId, entitySelection.key, baseDir);
  }
  const logFile = values.log
    ? resolve(
        deltaLogPath({
          ...(values['state-file'] ? { stateFile } : {}),
          stateDir: values['state-file'] ? undefined : dirname(stateFile),
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
        entities: entitySelection.selected,
        stateFile,
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
  const failedAttempt = (kind, error) => {
    registerAttempt('failure', { kind, message: String(error?.message ?? error) });
    return {
      ...errorResult(kind, String(error?.message ?? error), ids, format),
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
    } catch (err) {
      // TODO(v0.2): add a public `doctor`/`reset` state command so snapshot
      // recovery does not require parsing this error and deleting owned state by hand.
      return failedAttempt('snapshot', err);
    }
    let cutoff;
    try {
      cutoff = horizonCutoff(old);
    } catch (err) {
      return failedAttempt('snapshot', err);
    }
    let current;
    try {
      // Fetch broadly; filtering too early would make close/merge/relabel events disappear.
      current = {
        pr: entitySelection.wantsPr
          ? fetchPRs(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined,
        issue: entitySelection.wantsIssue
          ? fetchIssues(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined,
      };
    } catch (err) {
      return failedAttempt('github', err);
    }
    let baseline, deltas, snapshot, filteredDeltas;
    try {
      ({ baseline, deltas, snapshot } = detectDeltas(old, current, {
        emitBaselineState: values['baseline-emit-state'],
      }));
      // Attach the content-addressed id here: detect.mjs is repo-agnostic, but the
      // identity is scoped by repo. Rebuild each delta with `id` first so the
      // dedupe key leads the serialized object.
      deltas = deltas.map((d) => ({ id: deltaId(deltaIdentity(repo, d)), ...d }));
      if (selectedNumbers) deltas = deltas.filter((delta) => selectedNumbers.has(delta.number));
      if (attentionFiltering) {
        // `--settled` implies summaries even though the user need not spell out
        // `--summaries`; derive them before the settled predicate, then render
        // only the surviving deltas so display fields match filtered classes.
        for (const d of deltas) enrichDelta(d, { summaries: values.summaries || values.settled });
        const attention = applyAttentionFilters(deltas, {
          onlyClasses: onlyClasses.classes,
          ignoreClasses: ignoreClasses.classes,
          settled: false,
        });
        deltas = attention.deltas;
        filteredDeltas = attention.filteredDeltas;
        if (ignoreAuthors.authors.length) {
          const authorFiltered = deltas.map((delta) =>
            commentAuthorsIgnored(delta, ignoreAuthors.authors),
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
            legacyLine: values.detail || format === 'text',
            details: values.detail,
          });
        }
      } else {
        for (const d of deltas) {
          enrichDelta(d, {
            summaryLine: values['summary-line'] || values.detail,
            legacyLine: values.detail || format === 'text',
            details: values.detail,
            summaries: values.summaries,
          });
        }
      }
      // The snapshots retain bounded actionable metadata for a future tick, but
      // report/log deltas expose it only through --detail rows prepared above.
      deltas = deltas.map(hideInternalDetails);
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
        appendDeltaLog(
          logFile,
          { detectedAt: at, deltas },
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
          meta: { horizon: at, repo, monitorId, entities: entitySelection.selected },
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
    for (const delta of deltas) {
      const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
      if (
        watched &&
        ((watched.entry.until === 'merged' && delta.classes.includes('merged')) ||
          (watched.entry.until === 'closed' && delta.classes.includes('closed')))
      ) {
        try {
          removeWatchUnchanged(watched.path, watched.bytes);
        } catch (err) {
          return failedAttempt('io', err);
        }
      }
    }
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
      ...(attentionFiltering ? { filteredDeltas } : {}),
      summary,
    };
    const warnings = [
      ...derivationWarnings,
      ...(lockWarning ? [lockWarning] : []),
      ...monitorIdentityWarnings(),
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
    };
  } finally {
    // Every exit path from the try block above -- success or any thrown/
    // returned error -- releases the lock. releaseLock is a no-op if our
    // token no longer matches (ownership already lost; see the fence above).
    releaseLock(stateFile, lockToken, lockDeps);
  }
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
  const result = run(argv, deps);
  const outpostUrl = parseCli(argv).values?.['outpost-url'];
  if (!outpostUrl || result.code !== 10 || typeof result.report === 'string') {
    return { ...result, warnings: result.warnings ?? [] };
  }
  const values = parseCli(argv).values ?? {};
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
  const result = await runWithOutpost(argv, deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const format = result.format ?? 'json';

  if (format === 'text') {
    const body =
      result.report?.command === 'list'
        ? formatListTextOutput({ report: result.report })
        : result.report?.command === 'read'
          ? formatReadTextOutput({ code: result.code, report: result.report, now })
          : result.report?.command === 'log compact'
            ? formatCompactTextOutput({ report: result.report, now })
            : result.report?.command === 'cursor set'
              ? formatCursorSetTextOutput({ report: result.report, now })
              : formatTextOutput({ code: result.code, report: result.report, now });
    return {
      ...result,
      output: `${body}${formatOutpostWarnings(result.warnings)}\n`,
      stderr: '',
    };
  }

  const report =
    typeof result.report === 'string' || !result.warnings?.length
      ? result.report
      : { ...result.report, warnings: result.warnings };
  return {
    ...result,
    output: typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
    stderr: '',
  };
}
