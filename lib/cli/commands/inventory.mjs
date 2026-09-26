import { listMonitors as fsListMonitors, parseSince } from '../../list.mjs';
import { renderHelpText, renderHelpJson } from '../../help.mjs';
import { renderVersionText } from '../../version.mjs';
import { parseArgs } from 'node:util';
import { LIST_OPTIONS, formatSniff, STATUS_OPTIONS, commandHelp, watchNumbers } from '../parse.mjs';
import { errorResult } from '../errors.mjs';
import {
  defaultStateDir,
  economicalSnapshotPath,
  snapshotPath,
  readSnapshot as fsRead,
} from '../../snapshot.mjs';
import { defaultRegistryDir } from '../../registry.mjs';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';
import { applyConfig } from '../../config.mjs';
import { configDeps, selectedMonitorId } from '../config.mjs';
import { runDetector } from '../detector.mjs';
import {
  parseEntitySelection,
  validateRepo,
  defaultMonitorId,
  validateMonitorId,
} from '../../args.mjs';
import { resolveRepoFromLocalGit } from '../../repo-source.mjs';
import { readWatch } from '../../watch.mjs';
import { deltaSummary } from '../../summary.mjs';

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
    const refreshed = runDetector(refreshArgs, deps);
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

export { runStatus, runList };
