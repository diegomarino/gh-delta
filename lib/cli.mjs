import { parseArgs } from 'node:util';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './gh.mjs';
import { detectDeltas } from './detect.mjs';
import {
  readSnapshot as fsRead,
  snapshotPath,
  writeSnapshotAtomic as fsWrite,
} from './snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './outpost.mjs';
import {
  parseEntitySelection,
  parseOutpostArgs,
  validateMonitorId,
  validateRepo,
} from './args.mjs';
import { renderHelpJson, renderHelpText } from './help.mjs';
import { formatOutpostWarnings, formatTextOutput } from './text-output.mjs';
import { renderVersionText } from './version.mjs';

// Version of the machine-readable detector report shape. Bumped only on a
// breaking change (a field removed or renamed). Additive fields -- new optional
// keys on the report, a delta, or a fingerprint -- do not bump it. Consumers can
// assert `report.schemaVersion === 1` on every JSON response, success or error.
export const REPORT_SCHEMA_VERSION = 1;

function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.title}": ${d.classes.join(', ')}`;
}

// Stamp the schema version on error reports so they stay self-describing. Error
// reports are `{schemaVersion, error, at, repo?, monitorId?}` -- they never carry
// `deltas`, so consumers must branch on exit code (1) before reading `deltas`.
function errorReport(fields) {
  return { schemaVersion: REPORT_SCHEMA_VERSION, ...fields };
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function outputFormat(argv) {
  let format = 'json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format') {
      format = argv[i + 1] ?? 'json';
      i++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length);
    }
  }
  return format;
}

function argsForOutputFormat(argv) {
  return outputFormat(argv) === 'text' && !hasFlag(argv, '--detail') ? [...argv, '--detail'] : argv;
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
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        'monitor-id': { type: 'string' },
        entities: { type: 'string', default: 'pr,issue' },
        'state-file': { type: 'string' },
        'state-dir': { type: 'string' },
        format: { type: 'string', default: 'json' },
        detail: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        'help-json': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    return { code: 1, report: errorReport({ error: String(err?.message ?? err), at }) };
  }
  if (values.help) return { code: 0, report: renderHelpText('gh-delta') };
  if (values['help-json']) return { code: 0, report: renderHelpJson('gh-delta') };
  if (values.version) return { code: 0, report: renderVersionText() };
  if (!values.repo)
    return { code: 1, report: errorReport({ error: 'missing required --repo <owner/name>', at }) };
  if (!values['monitor-id'])
    return {
      code: 1,
      report: errorReport({ error: 'missing required --monitor-id <id>', repo: values.repo, at }),
    };
  const repoValidation = validateRepo(values.repo);
  if (!repoValidation.ok)
    return { code: 1, report: errorReport({ error: repoValidation.error, repo: values.repo, at }) };
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
    };
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
    if (values.detail) for (const d of deltas) d.line = line(d);
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
    return { code: baseline || deltas.length === 0 ? 0 : 10, report };
  } catch (err) {
    const report = errorReport({
      error: String(err?.message ?? err),
      repo: values.repo,
      monitorId: values['monitor-id'],
      at,
    });
    return { code: 1, report };
  }
}

/**
 * Run the detector and optionally deliver one outpost event per delta.
 *
 * Outpost validation happens before GitHub fetches. Delivery happens after the
 * snapshot write and returns warnings instead of changing the detector code.
 */
export async function runWithOutpost(argv, deps = {}) {
  const {
    outpostFetch = globalThis.fetch,
    outpostTimeoutMs,
    outpostMaxPosts,
    now = () => new Date().toISOString(),
  } = deps;
  const parsed = parseOutpostArgs(argv);
  if (parsed.error)
    return { code: 1, report: errorReport({ error: parsed.error, at: now() }), warnings: [] };

  let outpostUrl;
  if (parsed.outpostUrl !== undefined) {
    const validation = validateOutpostUrl(parsed.outpostUrl);
    if (!validation.ok)
      return { code: 1, report: errorReport({ error: validation.error, at: now() }), warnings: [] };
    outpostUrl = validation.url;
  }

  const result = run(parsed.detectorArgs, deps);
  if (!outpostUrl || result.code !== 10 || typeof result.report === 'string') {
    return { ...result, warnings: [] };
  }

  const { warnings } = await sendOutposts({
    outpostUrl,
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
  const format = outputFormat(argv);
  const result = await runWithOutpost(argsForOutputFormat(argv), deps);
  const now = deps.now ?? (() => new Date().toISOString());

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
