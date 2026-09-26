// Multi-repository preflight validation and shared detector report envelopes.
import {
  parseCli,
  positiveInt,
  nonNegativeSafeInt,
  watchNumbers,
  parseDeltaClassSelection,
} from './parse.mjs';
import { selectedMonitorId } from './config.mjs';
import {
  defaultMonitorId,
  validateMonitorId,
  parseEntitySelection,
  parseIgnoreAuthors,
  parseEnrichmentSelection,
} from '../args.mjs';
import { errorResult } from './errors.mjs';
import { parseDuration } from '../duration.mjs';
import { validateOutpostUrl } from '../outpost.mjs';
import { REPORT_SCHEMA_VERSION } from '../contract.mjs';
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
// per-repo runDetector results. Every detector-tick invocation that knows its
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

export { aggregateError, buildDetectorReport, multiConfigError };
