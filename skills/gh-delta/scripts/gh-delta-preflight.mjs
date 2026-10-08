/**
 * Read-only prerequisite check for gh-delta-quickstart.sh.
 *
 * Internal invocation: node gh-delta-preflight.mjs <validated-scope>.
 * The Bash entry point validates scope and calls this both for --check and
 * before polling. No state, registry, authentication, or config is written.
 * GitHub CLI's repo fallback may make a read-only API request.
 *
 * Stdout: one JSON object { ready, repo, host, launcher, reason, scope? }.
 * Exit 0 means ready; exit 1 means unavailable. Resolved fields remain present
 * on failure when known. launcher is an argv array, never executable text.
 * Each prerequisite subprocess has a ten-second deadline and no stdin.
 * Authentication output is captured but never printed, to avoid credentials.
 *
 * Standalone by design: installed skills do not include CLI internal modules.
 * Keep remote selection and configuration precedence aligned with repo-source
 * and config modules; only conflicts that affect this quickstart are checked.
 * See ../references/quickstart.md for supported configuration and failure modes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const scope = process.argv[2];
const report = { ready: false, repo: null, host: null, launcher: null, reason: null };
function unavailable(reason) {
  report.reason = reason;
  console.log(JSON.stringify(report));
  process.exit(1);
}
function command(program, args, env = process.env) {
  return spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 10000,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
if (Number(process.versions.node.split('.')[0]) < 22)
  unavailable('Node.js 22 or newer is required.');
const binary = command('gh-delta', ['--version']);
if (binary.status === 0) report.launcher = ['gh-delta'];
else {
  const extension = command('gh', ['delta', '--version']);
  if (extension.status !== 0) {
    const error = (result) =>
      result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    unavailable(
      `No CLI launcher: gh-delta: ${error(binary)}; gh delta: ${error(extension)}. Installing the skill does not install the CLI.`,
    );
  }
  report.launcher = ['gh', 'delta'];
}

const remotes = ['origin', 'upstream']
  .map((name) => command('git', ['remote', 'get-url', name]))
  .filter((result) => result.status === 0)
  .map((result) => result.stdout.trim());
if (!remotes.length)
  unavailable('Run from a repository checkout with a GitHub origin or upstream remote.');
for (const remote of remotes) {
  let host, pathname;
  try {
    if (/^(https?|ssh):\/\//i.test(remote)) {
      const url = new URL(remote);
      host = url.hostname;
      pathname = url.pathname;
    } else {
      const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
      if (!match) continue;
      [, host, pathname] = match;
    }
    const parts = pathname
      .replace(/\.git\/?$/i, '')
      .split('/')
      .filter(Boolean);
    if (host.toLowerCase() !== 'github.com' || parts.length !== 2) continue;
    report.repo = parts.join('/');
    report.host = 'github.com';
    break;
  } catch {
    // Let gh resolve Enterprise hosts and SSH aliases below.
  }
}
// Enterprise and SSH aliases need gh's host knowledge, not guessed hostnames.
if (!report.repo) {
  // GH_REPO overrides checkout discovery; the quickstart follows its remote.
  const checkoutEnv = { ...process.env };
  delete checkoutEnv.GH_REPO;
  const resolved = command('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], checkoutEnv);
  try {
    if (resolved.status !== 0) throw new Error('remote unavailable');
    const repo = JSON.parse(resolved.stdout);
    report.repo = repo.nameWithOwner;
    report.host = new URL(repo.url).hostname;
  } catch {
    unavailable('The checkout remote could not be resolved as a GitHub repository.');
  }
}
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(report.repo) ||
  report.repo.split('/').some((part) => /^\.+$/.test(part)) ||
  !/^[A-Za-z0-9.-]+$/.test(report.host)
) {
  unavailable('The GitHub remote returned an invalid repository or host.');
}
const auth = command('gh', ['auth', 'status', '--active', '--hostname', report.host]);
if (auth.status !== 0)
  unavailable(
    `GitHub CLI is not authenticated for ${report.host}; check gh auth status --active --hostname ${report.host}.`,
  );

// Match CLI layering: environment > project > user. Explicit quickstart flags
// override identity, state directory, scope, format, and template at launch.
let settings = {};
for (const file of [
  join(homedir(), '.config', 'gh-delta', 'config.json'),
  join(process.cwd(), '.gh-delta.json'),
]) {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('expected an object');
    settings = { ...settings, ...config };
  } catch (error) {
    if (error.code !== 'ENOENT')
      unavailable(
        `Cannot read gh-delta configuration at ${file}: ${error.code ?? 'invalid JSON or configuration object'}.`,
      );
  }
}
const blocked = [
  'state-file',
  'watch-dir',
  'watch-strict',
  'number',
  'only-classes',
  'ignore-classes',
  'ignore-authors',
  'settled',
  'baseline-emit-state',
  'outpost-url',
  'outpost-secret',
  'omit-end',
  'template-sha256',
];
const boolean = new Set(['watch-strict', 'settled', 'baseline-emit-state', 'omit-end']);
for (const key of [...blocked, 'repo']) {
  const envKey = `GH_DELTA_${key.replaceAll('-', '_').toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== '') {
    if (boolean.has(key)) {
      if (!['true', 'false', '1', '0'].includes(raw.toLowerCase()))
        unavailable(`Invalid ${envKey}; expected true, false, 1, or 0.`);
      settings[key] = ['true', '1'].includes(raw.toLowerCase());
    } else settings[key] = raw;
  }
}
if (
  settings.repo &&
  (typeof settings.repo !== 'string' || settings.repo.toLowerCase() !== report.repo.toLowerCase())
) {
  unavailable(
    'Inherited repo configuration selects a different remote; use the advanced monitoring workflow.',
  );
}
for (const key of blocked) {
  if (settings[key] !== undefined && !(boolean.has(key) && settings[key] === false)) {
    unavailable(
      `Inherited ${key} conflicts with the session quickstart; use the advanced monitoring workflow without changing existing configuration.`,
    );
  }
}
report.ready = true;
report.scope = scope;
console.log(JSON.stringify(report));
