// DX commands are local orchestration around the existing detector boundaries.
// They never mutate GitHub; init's only writes are its project config and the
// normal detector baseline, while doctor/explain are read-only.
import {
  accessSync,
  closeSync as nodeCloseSync,
  existsSync as nodeExistsSync,
  fsyncSync as nodeFsyncSync,
  openSync as nodeOpenSync,
  writeSync as nodeWriteSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { diffFingerprint } from './diff.mjs';

export function isTemporaryPath(path, temporaryRoot = tmpdir()) {
  const target = resolve(path);
  const root = resolve(temporaryRoot);
  const relation = relative(root, target);
  return (
    relation === '' ||
    (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
  );
}

// `wx` makes the final operation exclusive: a concurrent init can never
// replace an existing project config after the friendly preflight check.
export function writeConfigDurableNoOverwrite(
  path,
  config,
  {
    fs = {
      openSync: nodeOpenSync,
      writeSync: nodeWriteSync,
      fsyncSync: nodeFsyncSync,
      closeSync: nodeCloseSync,
    },
  } = {},
) {
  const descriptor = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(config, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function initializeMonitor(
  { repo, stateDir, monitorId, entities = 'pr,issue', configPath, stateFile },
  {
    existsSync = nodeExistsSync,
    writeFileSync = nodeWriteFileSync,
    writeConfig,
    isTemporaryPath: temporary = isTemporaryPath,
    tick,
  } = {},
) {
  if (temporary(stateDir))
    return { code: 2, error: '--state-dir for init must be durable, not temporary' };
  if (existsSync(configPath))
    return { code: 2, error: `${configPath} already exists; init will not overwrite it` };
  if (stateFile && existsSync(stateFile))
    return {
      code: 2,
      error: `${stateFile} already exists; init will not consume its pending monitor changes`,
    };
  const baseline = tick();
  if (baseline.code !== 0 && baseline.code !== 10) return baseline;
  const config = { repo, 'state-dir': stateDir, 'monitor-id': monitorId };
  if (entities !== 'pr,issue') config.entities = entities;
  try {
    if (writeConfig) writeConfig(configPath, config);
    else if (writeFileSync !== nodeWriteFileSync)
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    else writeConfigDurableNoOverwrite(configPath, config);
  } catch (error) {
    if (error?.code === 'EEXIST')
      return { code: 2, error: `${configPath} already exists; init will not overwrite it` };
    return {
      code: 1,
      kind: 'io',
      error: `could not create ${configPath}: ${error?.message ?? error}`,
    };
  }
  return {
    code: 0,
    report: {
      schemaVersion: 1,
      command: 'init',
      repo,
      stateDir,
      configPath,
      stateFile: baseline.report?.results?.[0]?.stateFile,
      baseline: Boolean(baseline.report?.results?.[0]?.baseline),
      nextCommand: 'gh-delta',
    },
  };
}

function row(name, ok, detail, level = ok ? 'ok' : 'error') {
  return { name, ok, level, detail };
}

export function runDoctorChecks(
  { repo, stateDir, monitorId, machineId },
  {
    ghInstalled = () => true,
    ghAuthenticated = () => true,
    orgScope = () => ({ needed: false, ok: true }),
    graphqlRateLimit = () => null,
    stateDir: inspectStateDir = () => ({ exists: true, writable: true }),
    nodeVersion = () => Number(process.versions.node.split('.')[0]),
    registryEntries = () => [],
    isTemporaryPath: temporary = isTemporaryPath,
  } = {},
) {
  const gh = Boolean(ghInstalled());
  const auth = gh && Boolean(ghAuthenticated());
  const scope = orgScope(repo);
  let quota;
  try {
    quota = graphqlRateLimit();
  } catch (error) {
    quota = { error: String(error?.message ?? error) };
  }
  let state;
  try {
    state = inspectStateDir(stateDir);
  } catch (error) {
    state = { exists: false, writable: false, error: String(error?.message ?? error) };
  }
  let collisions = [];
  let registryError;
  try {
    collisions = registryEntries().filter(
      (entry) =>
        entry.repo === repo && entry.monitorId !== monitorId && entry.machineId === machineId,
    );
  } catch (error) {
    registryError = String(error?.message ?? error);
  }
  const checks = [
    row('gh-installed', gh, gh ? 'gh is available' : 'install GitHub CLI (gh)'),
    row('gh-authenticated', auth, auth ? 'active gh authentication found' : 'run gh auth login'),
    row(
      'org-scope',
      scope.ok,
      scope.needed
        ? scope.ok
          ? 'read:org available'
          : 'run gh auth refresh -s read:org'
        : 'not needed for this repository',
    ),
    row(
      'graphql-rate-limit',
      !quota?.error,
      quota?.error ??
        (quota ? `${quota.remaining} remaining; reset ${quota.resetAt}` : 'not checked'),
      quota?.error ? 'warning' : 'ok',
    ),
    row(
      'state-dir',
      Boolean(state?.exists && state?.writable),
      state?.error ??
        (state?.exists && state?.writable ? 'exists and writable' : 'create it or fix permissions'),
    ),
    row('node', nodeVersion() >= 22, `Node ${nodeVersion()} (requires >=22)`),
    row(
      'registry',
      !registryError && collisions.length === 0,
      registryError ??
        (collisions.length
          ? `${collisions.length} other monitor(s) for ${repo}`
          : 'no monitor collision'),
      registryError || collisions.length ? 'warning' : 'ok',
    ),
    row(
      'state-dir-tmp',
      !temporary(stateDir),
      temporary(stateDir)
        ? 'temporary state can be cleaned; use a durable directory'
        : 'durable path',
      temporary(stateDir) ? 'warning' : 'ok',
    ),
  ];
  return {
    code: checks.some((check) => !check.ok && check.level === 'error') ? 1 : 0,
    report: { schemaVersion: 1, command: 'doctor', repo, stateDir, monitorId, checks },
  };
}

export function explainDelta(id, deltas) {
  const delta = deltas.find((candidate) => candidate.id === id);
  if (!delta) return { code: 2, error: `delta ${id} was not found in the supplied local input` };
  if (!Object.hasOwn(delta, 'from') || !Object.hasOwn(delta, 'to'))
    return {
      code: 2,
      error: `delta ${id} has compact changed fields only; supply a report with raw fingerprints`,
    };
  return {
    code: 0,
    report: {
      schemaVersion: 1,
      command: 'explain',
      id,
      classes: delta.classes ?? [],
      changed: diffFingerprint(delta.from, delta.to),
    },
  };
}

export function defaultStateDirInspection(path) {
  try {
    accessSync(path);
    accessSync(path, 2);
    return { exists: true, writable: true };
  } catch {
    return { exists: false, writable: false };
  }
}
