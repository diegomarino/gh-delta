// Configuration call-site policies and dependency selection for CLI commands.
import { readFileSync } from 'node:fs';
import { commandHelp, formatSniff } from './parse.mjs';
import { applyConfig } from '../config.mjs';
import { errorResult } from './errors.mjs';
import { parseArgs } from 'node:util';

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

export { parseCommandValues, selectedMonitorId, configDeps, envDisablesRegistry };
