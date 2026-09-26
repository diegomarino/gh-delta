import { parseCommandValues, selectedMonitorId } from '../config.mjs';
import { INIT_OPTIONS, DOCTOR_OPTIONS, EXPLAIN_OPTIONS, DEMO_OPTIONS } from '../parse.mjs';
import { errorResult } from '../errors.mjs';
import {
  parseEntitySelection,
  validateRepo,
  defaultMonitorId,
  validateMonitorId,
} from '../../args.mjs';
import { resolveRepoFromLocalGit } from '../../repo-source.mjs';
import { resolve, join } from 'node:path';
import { snapshotPath } from '../../snapshot.mjs';
import {
  initializeMonitor,
  writeConfigDurableNoOverwrite,
  runDoctorChecks,
  defaultStateDirInspection,
  explainDelta,
} from '../../dx.mjs';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  defaultMachineId,
  readRegistry as fsReadRegistry,
  defaultRegistryDir,
} from '../../registry.mjs';
import { fetchRateLimit as ghRateLimit } from '../../gh.mjs';
import { readDeltaLog as fsReadDeltaLog } from '../../deltalog.mjs';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/["\\\\]/g, '\\\\$&')}"`;
}

function agentCommand(repo, monitorId, entities, stateDir) {
  return [
    'gh-delta',
    '--repo',
    repo,
    '--monitor-id',
    monitorId,
    '--entities',
    entities,
    '--state-dir',
    stateDir,
  ];
}

function runInit(argv, deps = {}, { run }) {
  const parsed = parseCommandValues(argv, 'init', INIT_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'init' },
      'json',
    );
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at: parsed.at, command: 'init' },
      values.format,
    );
  const local = values.repo
    ? { status: 'found', repo: values.repo }
    : (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)();
  if (local.status !== 'found')
    return errorResult(
      'config',
      'init requires --repo or a repository remote in the current directory',
      { at: parsed.at, command: 'init' },
      values.format,
    );
  const repo = validateRepo(local.repo);
  if (!repo.ok)
    return errorResult('config', repo.error, { at: parsed.at, command: 'init' }, values.format);
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
      { at: parsed.at, command: 'init', repo: repo.repo },
      values.format,
    );
  const stateDir = resolve(values['state-dir'] ?? join(process.cwd(), '.gh-delta'));
  const configPath = resolve(process.cwd(), '.gh-delta.json');
  const entityValue = entities.selected.join(',');
  const stateFile = snapshotPath(repo.repo, monitorId, entities.key, stateDir);
  const result = initializeMonitor(
    { repo: repo.repo, stateDir, monitorId, entities: entityValue, configPath, stateFile },
    {
      existsSync: deps.existsSync ?? existsSync,
      writeFileSync: deps.writeFileSync ?? writeFileSync,
      writeConfig:
        deps.writeConfig ??
        (deps.writeFileSync
          ? undefined
          : (path, config) => writeConfigDurableNoOverwrite(path, config, { fs: deps.configFs })),
      isTemporaryPath: deps.isTemporaryPath,
      tick: () =>
        run(
          [
            '--repo',
            repo.repo,
            '--monitor-id',
            monitorId,
            '--state-dir',
            stateDir,
            '--entities',
            entityValue,
          ],
          deps,
        ),
    },
  );
  if (result.error)
    return errorResult(
      result.kind ?? 'config',
      result.error,
      { at: parsed.at, command: 'init', repo: repo.repo, monitorId },
      values.format,
    );
  const report = {
    ...result.report,
    at: parsed.at,
    ...(values.agent
      ? {
          agent: {
            cron: `* * * * * cd ${shellQuote(process.cwd())} && ${agentCommand(repo.repo, monitorId, entityValue, stateDir).map(shellQuote).join(' ')} >/dev/null`,
            systemd: `WorkingDirectory=${systemdQuote(process.cwd())}\nExecStart=${agentCommand(repo.repo, monitorId, entityValue, stateDir).map(systemdQuote).join(' ')}`,
            prompt:
              'Run gh-delta, inspect JSON only when exit code is 10, and never merge without approval.',
          },
        }
      : {}),
  };
  return { code: result.code, report, format: values.format, warnings: [] };
}

function runDoctor(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'doctor', DOCTOR_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'doctor' },
      'json',
    );
  const local = values.repo
    ? { status: 'found', repo: values.repo }
    : (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)();
  if (local.status !== 'found')
    return errorResult(
      'config',
      'doctor requires --repo or a repository remote in the current directory',
      { at: parsed.at, command: 'doctor' },
      values.format,
    );
  const repo = validateRepo(local.repo);
  if (!repo.ok)
    return errorResult('config', repo.error, { at: parsed.at, command: 'doctor' }, values.format);
  const monitorId = selectedMonitorId(
    values,
    deps.env ?? process.env,
    deps.defaultMonitor ?? defaultMonitorId,
  );
  const stateDir = resolve(values['state-dir'] ?? join(process.cwd(), '.gh-delta'));
  const exec =
    deps.doctorExec ??
    ((command, args) =>
      execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const safeGh = (args) => {
    try {
      exec('gh', args);
      return true;
    } catch {
      return false;
    }
  };
  const activeGhAccount = () => {
    try {
      const hosts = JSON.parse(
        exec('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']),
      ).hosts;
      return Object.values(hosts ?? {}).some(
        (accounts) =>
          Array.isArray(accounts) &&
          accounts.some(
            (account) =>
              (account.active === true || account.is_active === true) &&
              typeof account.login === 'string' &&
              account.login.length > 0,
          ),
      );
    } catch {
      return false;
    }
  };
  const inferredOrgScope = () => {
    try {
      const owner = JSON.parse(exec('gh', ['api', `repos/${repo.repo}`])).owner?.type;
      if (owner !== 'Organization') return { needed: false, ok: true };
      const auth = JSON.parse(
        exec('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']),
      );
      const scopes = JSON.stringify(auth).match(/"scopes"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';

      return { needed: true, ok: /"read:org"/.test(scopes) };
    } catch {
      // Auth/API failure is independently represented by the gh rows; do not
      // invent a scope failure from an unreadable diagnostic response.
      return { needed: false, ok: true };
    }
  };
  const result = runDoctorChecks(
    { repo: repo.repo, stateDir, monitorId, machineId: deps.machineId ?? defaultMachineId() },
    {
      ghInstalled: () => safeGh(['--version']),
      ghAuthenticated: activeGhAccount,
      orgScope: deps.orgScope ?? inferredOrgScope,
      graphqlRateLimit: deps.fetchRateLimit ?? (() => ghRateLimit({ exec })),
      stateDir: deps.inspectStateDir ?? defaultStateDirInspection,
      nodeVersion: deps.nodeVersion,
      registryEntries:
        deps.registryEntries ??
        (() =>
          (deps.readRegistry ?? fsReadRegistry)(
            defaultRegistryDir({ env: deps.env ?? process.env }),
          ).entries),
      isTemporaryPath: deps.isTemporaryPath,
    },
  );
  return {
    ...result,
    report: { ...result.report, at: parsed.at },
    format: values.format,
    warnings: [],
  };
}

function runExplain(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'explain', EXPLAIN_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values, positionals } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'explain' },
      'json',
    );
  if (positionals.length !== 1 || !/^[0-9a-f]{64}$/.test(positionals[0]))
    return errorResult(
      'config',
      'explain requires one 64-character delta id',
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  if (Boolean(values['log-file']) === Boolean(values['report-file']))
    return errorResult(
      'config',
      'explain requires exactly one of --log-file or --report-file',
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  try {
    const deltas = values['log-file']
      ? (deps.readDeltaLog ?? fsReadDeltaLog)(values['log-file']).entries.map(
          (entry) => entry.delta,
        )
      : (JSON.parse((deps.readFileSync ?? readFileSync)(values['report-file'], 'utf8')).deltas ??
        []);
    const result = explainDelta(positionals[0], deltas);
    if (result.error)
      return errorResult(
        'config',
        result.error,
        { at: parsed.at, command: 'explain' },
        values.format,
      );
    return {
      ...result,
      report: { ...result.report, at: parsed.at },
      format: values.format,
      warnings: [],
    };
  } catch (error) {
    return errorResult(
      'io',
      String(error?.message ?? error),
      { at: parsed.at, command: 'explain' },
      values.format,
    );
  }
}

function runDemo(argv, deps = {}) {
  const parsed = parseCommandValues(argv, 'demo', DEMO_OPTIONS, deps);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return parsed.error;
  const { values } = parsed.values;
  if (!['json', 'text'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json or text',
      { at: parsed.at, command: 'demo' },
      'json',
    );
  return {
    code: 0,
    format: values.format,
    warnings: [],
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'demo',
      at: parsed.at,
      repo: 'diegomarino/gh-delta-demo',
      commandLine: 'gh-delta --repo diegomarino/gh-delta-demo --state-dir .gh-delta-demo',
    },
  };
}

export { runInit, runDoctor, runExplain, runDemo };
