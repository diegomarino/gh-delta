import { parseArgs } from 'node:util';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './gh.mjs';
import { detectDeltas } from './detect.mjs';
import {
  readSnapshot as fsRead,
  snapshotPath,
  writeSnapshotAtomic as fsWrite,
} from './snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './outpost.mjs';
import { parseEntitySelection, validateMonitorId, validateRepo } from './args.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import { formatOutpostWarnings, formatTextOutput } from './text-output.mjs';
import { renderVersionText } from './version.mjs';

// Version of the machine-readable detector report shape. Bumped only on a
// breaking change (a field removed or renamed). Additive fields -- new optional
// keys on the report, a delta, or a fingerprint -- do not bump it. Consumers can
// assert `report.schemaVersion === 1` on every JSON response, success or error.
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Build a compact human-readable summary line for a single delta.
 */
function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.title}": ${d.classes.join(', ')}`;
}

// Stamp the schema version on error reports so they stay self-describing. Error
// reports are `{schemaVersion, error, at, repo?, monitorId?}` -- they never carry
// `deltas`, so consumers must branch on exit code (1) before reading `deltas`.
function errorReport(fields) {
  return { schemaVersion: REPORT_SCHEMA_VERSION, ...fields };
}

const CLI_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  format: { type: 'string', default: 'json' },
  detail: { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
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
  if (parsed.error)
    return { code: 1, report: errorReport({ error: parsed.error, at }), format: parsed.format };
  const values = parsed.values;
  const format = parsed.format;
  if (!values.repo)
    return {
      code: 1,
      report: errorReport({ error: 'missing required --repo <owner/name>', at }),
      format,
    };
  if (!values['monitor-id'])
    return {
      code: 1,
      report: errorReport({ error: 'missing required --monitor-id <id>', repo: values.repo, at }),
      format,
    };
  const repoValidation = validateRepo(values.repo);
  if (!repoValidation.ok)
    return {
      code: 1,
      report: errorReport({ error: repoValidation.error, repo: values.repo, at }),
      format,
    };
  const monitorValidation = validateMonitorId(values['monitor-id']);
  if (!monitorValidation.ok)
    return {
      code: 1,
      report: errorReport({
        error: monitorValidation.error,
        repo: values.repo,
        monitorId: values['monitor-id'],
        at,
      }),
      format,
    };
  if (values['state-file'] && values['state-dir'])
    return {
      code: 1,
      report: errorReport({
        error: '--state-file and --state-dir are mutually exclusive',
        repo: values.repo,
        monitorId: values['monitor-id'],
        at,
      }),
      format,
    };
  if (!values['state-file'] && !values['state-dir'])
    return {
      code: 1,
      report: errorReport({
        error: 'provide either --state-file <path> or --state-dir <dir>',
        repo: values.repo,
        monitorId: values['monitor-id'],
        at,
      }),
      format,
    };
  const entitySelection = parseEntitySelection(values.entities);
  if (!entitySelection.ok) {
    return {
      code: 1,
      report: errorReport({
        error: `--entities must include pr, issue, or both; got "${values.entities}"`,
        repo: values.repo,
        monitorId: values['monitor-id'],
        at,
      }),
      format,
    };
  }
  if (values.format !== 'json' && values.format !== 'text') {
    return {
      code: 1,
      report: errorReport({
        error: '--format must be json or text',
        repo: values.repo,
        monitorId: values['monitor-id'],
        at,
      }),
      format,
    };
  }
  if (values['outpost-url'] !== undefined) {
    const outpostValidation = validateOutpostUrl(values['outpost-url']);
    if (!outpostValidation.ok)
      return { code: 1, report: errorReport({ error: outpostValidation.error, at }), format };
  }
  try {
    const stateFile =
      values['state-file'] ??
      snapshotPath(values.repo, values['monitor-id'], entitySelection.key, values['state-dir']);
    const old = readSnapshot(stateFile);
    // Fetch broadly; filtering too early would make close/merge/relabel events disappear.
    const current = {
      pr: entitySelection.wantsPr ? fetchPRs(values.repo) : undefined,
      issue: entitySelection.wantsIssue ? fetchIssues(values.repo) : undefined,
    };
    const { baseline, deltas, snapshot } = detectDeltas(old, current);
    if (values.detail || format === 'text') for (const d of deltas) d.line = line(d);
    writeSnapshotAtomic(stateFile, snapshot);
    const summary = baseline
      ? `baseline established: ${Object.keys(snapshot.pr).length} PRs, ${Object.keys(snapshot.issue).length} issues`
      : `${deltas.length} delta(s)`;
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      baseline,
      repo: values.repo,
      monitorId: values['monitor-id'],
      entities: entitySelection.selected,
      at,
      deltas,
      summary,
    };
    return { code: baseline || deltas.length === 0 ? 0 : 10, report, format };
  } catch (err) {
    const report = errorReport({
      error: String(err?.message ?? err),
      repo: values.repo,
      monitorId: values['monitor-id'],
      at,
    });
    return { code: 1, report, format };
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
  const { outpostFetch = globalThis.fetch, outpostTimeoutMs, outpostMaxPosts } = deps;
  const result = run(argv, deps);
  const outpostUrl = parseCli(argv).values?.['outpost-url'];
  if (!outpostUrl || result.code !== 10 || typeof result.report === 'string') {
    return { ...result, warnings: [] };
  }
  const validated = validateOutpostUrl(outpostUrl);
  const { warnings } = await sendOutposts({
    outpostUrl: validated.url,
    report: result.report,
    fetchImpl: outpostFetch,
    timeoutMs: outpostTimeoutMs,
    maxPosts: outpostMaxPosts,
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

  return {
    ...result,
    output:
      typeof result.report === 'string'
        ? result.report
        : `${JSON.stringify(result.report, null, 2)}\n`,
    stderr: result.warnings?.length
      ? `${formatOutpostWarnings(result.warnings).trimStart()}\n`
      : '',
  };
}
