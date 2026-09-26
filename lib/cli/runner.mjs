// Dispatch and execution orchestration. Nested init/wait ticks receive run explicitly.
import { runInit, runDoctor, runExplain, runDemo } from './commands/dx.mjs';
import { runStatus, runList } from './commands/inventory.mjs';
import { runSchema } from './commands/schema.mjs';
import { runWatch } from './commands/watch.mjs';
import { runCompact, runReset } from './commands/maintenance.mjs';
import { runRead, runCursorSet } from './commands/cursor.mjs';
import { errorResult } from './errors.mjs';
import { formatSniff, explicitRepos, parseCli } from './parse.mjs';
import { runDetector } from './detector.mjs';
import { applyConfig } from '../config.mjs';
import { configDeps } from './config.mjs';
import { aggregateError, buildDetectorReport, multiConfigError } from './multi-repo.mjs';
import { defaultMonitorId, validateRepo } from '../args.mjs';
import { readWatch } from '../watch.mjs';
import { validateOutpostUrl, sendOutposts } from '../outpost.mjs';
import { runWait } from './commands/wait.mjs';
import { renderCommandResult } from './render.mjs';

function runSingle(argv, deps = {}) {
  if (argv[0] === 'init') return runInit(argv.slice(1), deps, { run });
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
  return runDetector(argv, deps);
}

/** Execute zero or more fully isolated repository ticks, serially. */
function run(argv, deps = {}) {
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
async function runWithOutpost(argv, deps = {}) {
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
async function runCommand(argv, deps = {}) {
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
      ? await runWait(effectiveArgv.slice(1), deps, { run })
      : await runWithOutpost(effectiveArgv, deps);
  return renderCommandResult(result, effectiveArgv, deps);
}

export { run, runWithOutpost, runCommand };
