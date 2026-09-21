// Local configuration loader. It deliberately only translates already-public
// long flags, so configuration cannot introduce a second, divergent grammar.
import { readFileSync as nodeReadFileSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_KEYS = Object.freeze([
  'repo',
  'monitor-id',
  'entities',
  'state-file',
  'state-dir',
  'watch-dir',
  'number',
  'format',
  'detail',
  'summaries',
  'enrich',
  'rate-limit-floor',
  'only-classes',
  'ignore-classes',
  'ignore-authors',
  'settled',
  'baseline-emit-state',
  'summary-line',
  'outpost-url',
  'outpost-secret',
  'outpost-timeout-ms',
  'outpost-max-posts',
  'gh-timeout-ms',
  'no-registry',
  'lock-stale-ms',
  'stale-after',
  'log',
]);

const BOOLEAN_KEYS = new Set([
  'detail',
  'summaries',
  'settled',
  'baseline-emit-state',
  'summary-line',
  'no-registry',
  'log',
]);
const CONFIG_KEY_SET = new Set(CONFIG_KEYS);

function readJson(path, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { error: `${path}: config must be a JSON object` };
    for (const [key, value] of Object.entries(parsed)) {
      if (!CONFIG_KEY_SET.has(key)) return { error: `${path}: unknown key ${key}` };
      if (
        value === null ||
        (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number')
      )
        return { error: `${path}: ${key} must be a string, number, or boolean` };
      if (BOOLEAN_KEYS.has(key) && typeof value !== 'boolean')
        return { error: `${path}: ${key} must be a boolean` };
    }
    return { value: parsed };
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null };
    return { error: `${path}: invalid JSON (${error?.message ?? error})` };
  }
}

function explicitKeys(argv, allowedKeys) {
  const keys = new Set();
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).split('=', 1)[0];
    if (allowedKeys.has(key)) keys.add(key);
  }
  return keys;
}

function envValues(env, allowedKeys) {
  const values = {};
  for (const key of CONFIG_KEYS) {
    if (!allowedKeys.has(key)) continue;
    // This legacy environment variable already has deliberately broad
    // truthiness semantics at the registry boundary (including values beyond
    // true/false). Leave it there so no-config invocations remain identical.
    if (key === 'no-registry') continue;
    const envKey = `GH_DELTA_${key.replaceAll('-', '_').toUpperCase()}`;
    if (env[envKey] === undefined || env[envKey] === '') continue;
    if (BOOLEAN_KEYS.has(key)) {
      const raw = String(env[envKey]).toLowerCase();
      if (!['1', 'true', '0', 'false'].includes(raw))
        return { error: `${envKey} must be true, false, 1, or 0` };
      values[key] = raw === '1' || raw === 'true';
    } else values[key] = String(env[envKey]);
  }
  return { value: values };
}

/**
 * Add implicit flag values with precedence explicit argv > environment >
 * project .gh-delta.json > user config > parser defaults. Missing config is a
 * no-op, preserving legacy argv exactly.
 */
export function applyConfig(
  argv,
  {
    env = process.env,
    cwd = process.cwd,
    homedir = nodeHomedir,
    readFileSync = nodeReadFileSync,
  } = {},
  { allowedKeys = CONFIG_KEYS } = {},
) {
  const allowed = new Set(allowedKeys);
  const projectPath = join(cwd(), '.gh-delta.json');
  const userPath = join(homedir(), '.config', 'gh-delta', 'config.json');
  const user = readJson(userPath, readFileSync);
  if (user.error) return { ok: false, error: user.error };
  const project = readJson(projectPath, readFileSync);
  if (project.error) return { ok: false, error: project.error };
  const environment = envValues(env, allowed);
  if (environment.error) return { ok: false, error: environment.error };
  const values = { ...(user.value ?? {}), ...(project.value ?? {}), ...environment.value };
  const supplied = explicitKeys(argv, allowed);
  const additions = [];
  for (const key of CONFIG_KEYS) {
    if (!allowed.has(key)) continue;
    if (supplied.has(key) || values[key] === undefined) continue;
    if (BOOLEAN_KEYS.has(key)) {
      if (values[key]) additions.push(`--${key}`);
    } else additions.push(`--${key}`, String(values[key]));
  }
  return {
    ok: true,
    argv: additions.length ? [...argv, ...additions] : argv,
    source: project.value ? projectPath : user.value ? userPath : null,
  };
}
