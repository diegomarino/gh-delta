// CLI orchestration seam. Chains the pure and boundary modules into one tick:
// args -> snapshot read -> GitHub fetch -> delta detection -> snapshot write ->
// optional outpost delivery -> report. Keeps every side effect at this layer so
// detect/fingerprint stay pure and independently testable.
import { parseArgs } from 'node:util';
import { mkdirSync, statSync } from 'node:fs';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './gh.mjs';
import { detectDeltas } from './detect.mjs';
import { ADDITIVE_COMPARED_FIELDS, deltaId, deltaIdentity } from './fingerprint.mjs';
import { deltaSummary } from './summary.mjs';
import {
  defaultStateDir,
  horizonCutoff,
  readSnapshot as fsRead,
  snapshotPath,
  writeSnapshotAtomic as fsWrite,
} from './snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './outpost.mjs';
import { listMonitors as fsListMonitors, parseSince } from './list.mjs';
import { defaultRegistryDir, registerMonitor as fsRegisterMonitor } from './registry.mjs';
import {
  defaultMonitorId,
  parseEntitySelection,
  validateMonitorId,
  validateRepo,
} from './args.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import { formatListTextOutput, formatOutpostWarnings, formatTextOutput } from './text-output.mjs';
import { renderVersionText } from './version.mjs';
import { REPORT_SCHEMA_VERSION } from './contract.mjs';
import { resolveRepoFromGit } from './repo-source.mjs';

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

function changedFingerprintFields(delta) {
  if (!delta.from || !delta.to) return [];
  const keys = new Set([...Object.keys(delta.from), ...Object.keys(delta.to)]);
  return [...keys]
    .filter(
      (key) =>
        // ciChecks/reviewSummary mirror the ci/reviews digests; surfacing them
        // here would only duplicate the digest transition (or invent one when a
        // pre-summary snapshot side simply lacks the field).
        !['missing', 'missingTicks', 'commentsOverflow', 'ciChecks', 'reviewSummary'].includes(key),
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
  return diff;
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
    case 'new-comments':
    case 'comments-removed':
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

// Permanent errors exit 2; transient errors exit 1.
const ERROR_EXIT_CODES = { config: 2, snapshot: 2, github: 1, io: 1 };

// GH_DELTA_NO_REGISTRY disables the run-registry breadcrumb, but only for
// values that actually mean "on". An explicit `0`, `false`, or empty string is
// treated as unset so a wrapper exporting GH_DELTA_NO_REGISTRY=0 to mean
// "registry ON" is not silently opted out. Every doc writes the opt-out as `=1`.
const REGISTRY_ENV_OFF = new Set(['', '0', 'false']);
function envDisablesRegistry(value) {
  return value !== undefined && !REGISTRY_ENV_OFF.has(String(value).trim().toLowerCase());
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

const CLI_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  format: { type: 'string', default: 'json' },
  detail: { type: 'boolean', default: false },
  summaries: { type: 'boolean', default: false },
  'baseline-emit-state': { type: 'boolean', default: false },
  'summary-line': { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
  'outpost-timeout-ms': { type: 'string', default: '4000' },
  'outpost-max-posts': { type: 'string' },
  'gh-timeout-ms': { type: 'string', default: '60000' },
  'no-registry': { type: 'boolean', default: false },
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
  if (argv[0] === 'list') return runList(argv.slice(1), deps);
  const {
    fetchPRs = ghPRs,
    fetchIssues = ghIssues,
    readSnapshot = fsRead,
    writeSnapshotAtomic = fsWrite,
    registerMonitor = fsRegisterMonitor,
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
  // Everything below, up to and including --outpost-max-posts, is repo-
  // INDEPENDENT config validation. It must run before repo derivation
  // (resolveRepo, below) because that can shell out to `gh` -- a network call.
  // A deterministic local config error must always be reported before any
  // GitHub access is attempted, whether the repo came from --repo or from
  // derivation.
  const monitorId = values['monitor-id'] ?? defaultMonitorId();
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
  if (values.format !== 'json' && values.format !== 'text')
    return errorResult('config', '--format must be json or text', { monitorId, at }, format);
  if (values['outpost-url'] !== undefined) {
    const outpostValidation = validateOutpostUrl(values['outpost-url']);
    if (!outpostValidation.ok)
      return errorResult('config', outpostValidation.error, { monitorId, at }, format);
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
    // TODO(v0.2): add a public `doctor`/`reset` state command so snapshot
    // recovery does not require parsing this error and deleting owned state by hand.
    return errorResult('snapshot', String(err?.message ?? err), ids, format);
  }
  let cutoff;
  try {
    cutoff = horizonCutoff(old);
  } catch (err) {
    return errorResult('snapshot', String(err?.message ?? err), ids, format);
  }
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
    ({ baseline, deltas, snapshot } = detectDeltas(old, current, {
      emitBaselineState: values['baseline-emit-state'],
    }));
    // Attach the content-addressed id here: detect.mjs is repo-agnostic, but the
    // identity is scoped by repo. Rebuild each delta with `id` first so the
    // dedupe key leads the serialized object.
    deltas = deltas.map((d) => ({ id: deltaId(deltaIdentity(repo, d)), ...d }));
    for (const d of deltas) {
      enrichDelta(d, {
        summaryLine: values['summary-line'] || values.detail,
        legacyLine: values.detail || format === 'text',
        details: values.detail,
        summaries: values.summaries,
      });
    }
  } catch (err) {
    return errorResult('github', String(err?.message ?? err), ids, format);
  }
  try {
    // Self-describing snapshot: identity travels in the data, not only in the
    // derived filename, so `list` can recognize --state-file snapshots too.
    writeSnapshotAtomic(
      stateFile,
      {
        ...snapshot,
        meta: { horizon: at, repo, monitorId, entities: entitySelection.selected },
      },
      usedDefaultDir ? { dirMode: 0o700 } : undefined,
    );
  } catch (err) {
    return errorResult('io', String(err?.message ?? err), ids, format);
  }
  if (!values['no-registry'] && !envDisablesRegistry(env.GH_DELTA_NO_REGISTRY)) {
    try {
      registerMonitor({
        repo,
        monitorId,
        entities: entitySelection.selected,
        stateFile,
        lastRun: at,
        env,
      });
    } catch {
      // The registry is a best-effort breadcrumb for `gh-delta list`; a
      // failure to write it never changes the detector result or exit code.
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
    at,
    deltas,
    summary,
  };
  return {
    // A baseline normally exits 0 with empty deltas; --baseline-emit-state makes
    // it emit baseline-state deltas, and any run with deltas exits 10. Since only
    // that flag can pair baseline === true with a non-empty deltas array, this
    // stays byte-identical to `baseline || deltas.length === 0 ? 0 : 10` on every
    // pre-existing path.
    code: deltas.length === 0 ? 0 : 10,
    report,
    format,
    warnings: derivationWarnings,
  };
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
    return { ...result, warnings: result.warnings ?? [] };
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
