import { renderHelpText, renderHelpJson } from '../../help.mjs';
import { renderVersionText } from '../../version.mjs';
import { errorResult, ERROR_EXIT_CODES } from '../errors.mjs';
import {
  DELTA_SUMMARY_FIELDS,
  DELTA_SUMMARY_ENUMS,
  REPORT_SCHEMA_VERSION,
} from '../../contract.mjs';
import {
  WAIT_OPTIONS,
  formatSniff,
  parseDeltaClassSelection,
  watchNumbers,
  explicitRepos,
} from '../parse.mjs';
import { deltaSummary } from '../../summary.mjs';
import { utimesSync, mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDuration } from '../../duration.mjs';
import { readSnapshot as fsRead, snapshotPath } from '../../snapshot.mjs';
import { parseEntitySelection, defaultMonitorId } from '../../args.mjs';
import { selectedMonitorId } from '../config.mjs';
import { runBoundedWait } from '../../wait.mjs';
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
// `runDetector`), so recomputing via `deltaSummary(delta)` here would silently
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
async function runWait(argv, deps = {}, { run }) {
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

export { runWait };
