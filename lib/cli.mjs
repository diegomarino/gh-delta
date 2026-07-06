// CLI orchestration seam. Chains the pure and boundary modules into one tick:
// args -> snapshot read -> GitHub fetch -> delta detection -> snapshot write ->
// optional outpost delivery -> report. Keeps every side effect at this layer so
// detect/fingerprint stay pure and independently testable.
import { parseArgs } from 'node:util';
import { mkdirSync, statSync } from 'node:fs';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './gh.mjs';
import { detectDeltas } from './detect.mjs';
import {
  defaultStateDir,
  horizonCutoff,
  readSnapshot as fsRead,
  snapshotPath,
  writeSnapshotAtomic as fsWrite,
} from './snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './outpost.mjs';
import {
  defaultMonitorId,
  parseEntitySelection,
  validateMonitorId,
  validateRepo,
} from './args.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import { formatOutpostWarnings, formatTextOutput } from './text-output.mjs';
import { renderVersionText } from './version.mjs';
import { REPORT_SCHEMA_VERSION } from './contract.mjs';

// Version of the machine-readable detector report shape. Bumped only on a
// breaking change (a field removed or renamed). Additive fields -- new optional
// keys on the report, a delta, or a fingerprint -- do not bump it. Consumers can
// assert `report.schemaVersion === 1` on every JSON response, success or error.
export { REPORT_SCHEMA_VERSION };

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
  details.push(fieldDetail(klass, field, from, to, { delta: to - from }));
}

function pushLabelDelta(details, klass, delta) {
  const from = hasField(delta.from, 'labels') ? delta.from.labels : [];
  const to = hasField(delta.to, 'labels') ? delta.to.labels : [];
  const oldLabels = new Set(from);
  const newLabels = new Set(to);
  details.push({
    class: klass,
    field: 'labels',
    added: to.filter((label) => !oldLabels.has(label)),
    removed: from.filter((label) => !newLabels.has(label)),
  });
}

function changedFingerprintFields(delta) {
  if (!delta.from || !delta.to) return [];
  const keys = new Set([...Object.keys(delta.from), ...Object.keys(delta.to)]);
  return [...keys]
    .filter((key) => !['missing', 'missingTicks', 'commentsOverflow'].includes(key))
    .filter((key) => JSON.stringify(delta.from[key]) !== JSON.stringify(delta.to[key]))
    .sort();
}

// Expand one delta class into the schema's field-level `details` entries: the
// concrete from/to changes (state, labels, ci, presence, ...) a consumer needs
// to act without re-diffing the raw fingerprints. Each class maps to the fields
// it can meaningfully explain; opaque digests (ci/reviews) are marked as such.
function detailForClass(delta, klass) {
  const details = [];
  switch (klass) {
    case 'new':
      details.push({ class: klass, field: 'presence', from: null, to: 'present' });
      pushFieldDetail(details, klass, delta, 'state');
      break;
    case 'missing':
    case 'still-missing':
    case 'presumed-deleted':
      details.push(
        fieldDetail(klass, 'presence', 'present', 'missing', {
          missingTicks: delta.from?.missingTicks ?? (klass === 'missing' ? 1 : undefined),
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
      pushFieldDetail(details, klass, delta, 'isDraft');
      break;
    case 'ci-changed':
      // TODO(v0.2): persist normalized check/status summaries so this can name
      // the exact checks that changed instead of only exposing the opaque digest.
      pushFieldDetail(details, klass, delta, 'ci', { opaque: true });
      break;
    case 'review-changed':
      pushFieldDetail(details, klass, delta, 'review');
      // TODO(v0.2): persist a compact review summary if agents need author/state
      // context beyond the opaque latest-reviews digest.
      pushFieldDetail(details, klass, delta, 'reviews', { opaque: true });
      break;
    case 'became-mergeable':
      pushFieldDetail(details, klass, delta, 'mergeable');
      break;
    case 'new-comments':
      pushNumericDelta(details, klass, delta, 'comments');
      break;
    case 'unresolved-threads-added':
    case 'unresolved-threads-resolved':
      pushNumericDelta(details, klass, delta, 'unresolvedReviewThreads');
      break;
    case 'review-threads-changed':
      pushNumericDelta(details, klass, delta, 'reviewThreads');
      break;
    case 'relabeled':
      pushLabelDelta(details, klass, delta);
      break;
    case 'updated':
      for (const field of changedFingerprintFields(delta)) {
        const extra = ['ci', 'reviews'].includes(field) ? { opaque: true } : {};
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
export function enrichDelta(delta, { summaryLine = false, legacyLine = false, details = false }) {
  const rendered = line(delta);
  if (summaryLine) delta.summaryLine = rendered;
  if (legacyLine) delta.line = rendered;
  if (details) delta.details = detailDelta(delta);
}

// Permanent errors exit 2; transient errors exit 1.
const ERROR_EXIT_CODES = { config: 2, snapshot: 2, github: 1, io: 1 };

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

const CLI_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  format: { type: 'string', default: 'json' },
  detail: { type: 'boolean', default: false },
  'summary-line': { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
  'outpost-timeout-ms': { type: 'string', default: '4000' },
  'outpost-max-posts': { type: 'string' },
  'gh-timeout-ms': { type: 'string', default: '60000' },
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

// deps keeps the CLI testable without shelling out to gh or touching disk.
/**
 * Run one detector pass and return a machine-readable result.
 *
 * The function performs argument validation, fetches requested GitHub entity
 * families, compares them with the prior snapshot, and writes the next snapshot
 * only after a successful fetch and diff. It never exits the process directly.
 */
export function run(argv, deps = {}) {
  const {
    fetchPRs = ghPRs,
    fetchIssues = ghIssues,
    readSnapshot = fsRead,
    writeSnapshotAtomic = fsWrite,
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  const parsed = parseCli(argv);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return errorResult('config', parsed.error, { at }, parsed.format);
  const values = parsed.values;
  const format = parsed.format;
  if (!values.repo)
    return errorResult('config', 'missing required --repo <owner/name>', { at }, format);
  const repoValidation = validateRepo(values.repo);
  if (!repoValidation.ok)
    return errorResult('config', repoValidation.error, { repo: values.repo, at }, format);
  const repo = repoValidation.repo;
  const monitorId = values['monitor-id'] ?? defaultMonitorId();
  const monitorValidation = validateMonitorId(monitorId);
  if (!monitorValidation.ok)
    return errorResult('config', monitorValidation.error, { repo, monitorId, at }, format);
  if (values['state-file'] && values['state-dir'])
    return errorResult(
      'config',
      '--state-file and --state-dir are mutually exclusive',
      { repo, monitorId, at },
      format,
    );
  const entitySelection = parseEntitySelection(values.entities);
  if (!entitySelection.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { repo, monitorId, at },
      format,
    );
  if (values.format !== 'json' && values.format !== 'text')
    return errorResult('config', '--format must be json or text', { repo, monitorId, at }, format);
  const ids = { repo, monitorId, at };
  if (values['outpost-url'] !== undefined) {
    const outpostValidation = validateOutpostUrl(values['outpost-url']);
    if (!outpostValidation.ok) return errorResult('config', outpostValidation.error, ids, format);
  }
  const outpostTimeout = positiveInt('--outpost-timeout-ms', values['outpost-timeout-ms']);
  if (outpostTimeout.error) return errorResult('config', outpostTimeout.error, ids, format);
  let outpostMax = { value: Infinity };
  if (values['outpost-max-posts'] !== undefined) {
    outpostMax = positiveInt('--outpost-max-posts', values['outpost-max-posts']);
    if (outpostMax.error) return errorResult('config', outpostMax.error, ids, format);
  }
  const ghTimeoutMs = positiveInt('--gh-timeout-ms', values['gh-timeout-ms']);
  if (ghTimeoutMs.error) return errorResult('config', ghTimeoutMs.error, ids, format);
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
  let old;
  try {
    old = readSnapshot(stateFile);
  } catch (err) {
    return errorResult('snapshot', String(err?.message ?? err), ids, format);
  }
  const cutoff = horizonCutoff(old);
  let current;
  try {
    // Fetch broadly; filtering too early would make close/merge/relabel events disappear.
    current = {
      pr: entitySelection.wantsPr
        ? fetchPRs(repo, { timeoutMs: ghTimeoutMs.value, horizonCutoff: cutoff })
        : undefined,
      issue: entitySelection.wantsIssue
        ? fetchIssues(repo, { timeoutMs: ghTimeoutMs.value, horizonCutoff: cutoff })
        : undefined,
    };
  } catch (err) {
    return errorResult('github', String(err?.message ?? err), ids, format);
  }
  let baseline, deltas, snapshot;
  try {
    ({ baseline, deltas, snapshot } = detectDeltas(old, current));
    for (const d of deltas) {
      enrichDelta(d, {
        summaryLine: values['summary-line'] || values.detail,
        legacyLine: values.detail || format === 'text',
        details: values.detail,
      });
    }
  } catch (err) {
    return errorResult('github', String(err?.message ?? err), ids, format);
  }
  try {
    writeSnapshotAtomic(
      stateFile,
      { ...snapshot, meta: { horizon: at } },
      usedDefaultDir ? { dirMode: 0o700 } : undefined,
    );
  } catch (err) {
    return errorResult('io', String(err?.message ?? err), ids, format);
  }
  const summary = baseline
    ? `baseline established: ${Object.keys(snapshot.pr).length} PRs, ${Object.keys(snapshot.issue).length} issues`
    : `${deltas.length} delta(s)`;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    baseline,
    repo,
    monitorId,
    entities: entitySelection.selected,
    stateFile,
    at,
    deltas,
    summary,
  };
  return { code: baseline || deltas.length === 0 ? 0 : 10, report, format };
}

/**
 * Run the detector and optionally deliver one outpost event per delta.
 *
 * Outpost validation happens before GitHub fetches (inside `run`). Delivery
 * happens after the snapshot write and returns warnings instead of changing
 * the detector code.
 */
export async function runWithOutpost(argv, deps = {}) {
  const { outpostFetch = globalThis.fetch } = deps;
  const result = run(argv, deps);
  const outpostUrl = parseCli(argv).values?.['outpost-url'];
  if (!outpostUrl || result.code !== 10 || typeof result.report === 'string') {
    return { ...result, warnings: [] };
  }
  const values = parseCli(argv).values ?? {};
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
  });
  return { ...result, warnings };
}

/**
 * Run the public CLI command and return process-ready stdout/stderr strings.
 */
export async function runCommand(argv, deps = {}) {
  const result = await runWithOutpost(argv, deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const format = result.format ?? 'json';

  if (format === 'text') {
    return {
      ...result,
      output: `${formatTextOutput({ code: result.code, report: result.report, now })}${formatOutpostWarnings(result.warnings)}\n`,
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
