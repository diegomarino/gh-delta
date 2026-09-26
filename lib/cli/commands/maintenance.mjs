import { unlinkSync } from 'node:fs';
import {
  acquireLock as fsAcquireLock,
  assertLockOwned as fsAssertLockOwned,
  extendLockDeadline as fsExtendLockDeadline,
  releaseLock as fsReleaseLock,
} from '../../lock.mjs';
import {
  compactDeltaLog as fsCompactDeltaLog,
  deltaLogPath,
  resetDeltaLog as fsResetDeltaLog,
} from '../../deltalog.mjs';
import {
  defaultMonitorId,
  validateMonitorId,
  parseEntitySelection,
  validateRepo,
} from '../../args.mjs';
import { commandHelp, COMPACT_OPTIONS, formatSniff, RESET_OPTIONS } from '../parse.mjs';
import { parseArgs } from 'node:util';
import { errorResult } from '../errors.mjs';
import { parseDuration } from '../../duration.mjs';
import { selectedMonitorId } from '../config.mjs';
import { snapshotPath } from '../../snapshot.mjs';
import { resolve } from 'node:path';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';

// Idempotent: deleting an already-absent snapshot is not an error.
function fsDeleteSnapshot(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function runCompact(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    releaseLock = fsReleaseLock,
    compactDeltaLog = fsCompactDeltaLog,
    now = () => new Date().toISOString(),
    lockNow = () => Date.now(),
    lockFs,
    env = process.env,
    defaultMonitor = defaultMonitorId,
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta log compact');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: COMPACT_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'log compact' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult(
      'config',
      '--format must be json or text',
      { at, command: 'log compact' },
      'json',
    );
  if (!values.keep)
    return errorResult('config', '--keep is required', { at, command: 'log compact' }, format);
  let keep;
  if (
    /^[0-9]+$/.test(values.keep) &&
    Number.isSafeInteger(Number(values.keep)) &&
    Number(values.keep) > 0
  )
    keep = { count: Number(values.keep) };
  else {
    const duration = parseDuration(values.keep, { flag: '--keep' });
    if (duration.error)
      return errorResult(
        'config',
        '--keep must be a positive safe integer count or positive duration (e.g. 7d)',
        { at, command: 'log compact' },
        format,
      );
    const cutoff = Date.parse(at) - duration.ms;
    if (!Number.isSafeInteger(duration.ms) || !Number.isSafeInteger(cutoff))
      return errorResult(
        'config',
        '--keep duration is outside the supported safe integer range',
        { at, command: 'log compact' },
        format,
      );
    keep = { sinceMs: cutoff };
  }
  if (!!values['state-file'] === !!values['state-dir'])
    return errorResult(
      'config',
      'exactly one of --state-file or --state-dir is required',
      { at, command: 'log compact' },
      format,
    );
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok)
    return errorResult('config', monitor.error, { at, command: 'log compact' }, format);
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at, command: 'log compact' },
      format,
    );
  const repo = validateRepo(values.repo);
  if (!repo.ok)
    return errorResult(
      'config',
      values.repo ? repo.error : '--repo is required for log compact',
      { at, command: 'log compact' },
      format,
    );
  const stateFile =
    values['state-file'] ?? snapshotPath(repo.repo, monitorId, entities.key, values['state-dir']);
  const logFile = resolve(
    deltaLogPath(
      values['state-file']
        ? { stateFile }
        : { stateDir: values['state-dir'], repo: repo.repo, monitorId, entities: entities.key },
    ),
  );
  const lockOpts = { ghTimeoutMs: 60000, staleMs: 600000, fs: lockFs, now: lockNow };
  let token;
  try {
    const acquired = acquireLock(stateFile, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `state file locked (${acquired.reason}): ${stateFile}`,
        { at, command: 'log compact' },
        format,
      );
    token = acquired.token;
    const result = compactDeltaLog(
      logFile,
      { keep },
      {
        onProgress: () => extendLockDeadline(stateFile, token, lockOpts),
        verifyBeforeMutation: () => assertLockOwned(stateFile, token, lockOpts),
      },
    );
    return {
      code: 0,
      format,
      warnings: [],
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'log compact',
        logFile,
        at,
        keep: values.keep,
        ...result,
        summary: `retained ${result.retained.count} record(s)`,
      },
    };
  } catch (err) {
    return errorResult(
      err?.code === 'LOCK_LOST' ? 'busy' : err?.kind === 'log' ? 'log' : 'io',
      String(err?.message ?? err),
      { at, command: 'log compact' },
      format,
    );
  } finally {
    if (token) releaseLock(stateFile, token, lockOpts);
  }
}

// The public `reset` state command: re-baselining a monitor used to require
// parsing a `snapshot`/`log` error and deleting owned state by hand.
// Deletes the snapshot, the log manifest, and the log's physical dataFile
// under the monitor lock; the lock is released last (the `finally` below) so
// a concurrent tick waiting on it can never observe a half-deleted monitor.
function runReset(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    releaseLock = fsReleaseLock,
    resetDeltaLog = fsResetDeltaLog,
    deleteSnapshot = fsDeleteSnapshot,
    now = () => new Date().toISOString(),
    lockNow = () => Date.now(),
    lockFs,
    env = process.env,
    defaultMonitor = defaultMonitorId,
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta reset');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: RESET_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'reset' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult('config', '--format must be json or text', { at, command: 'reset' }, 'json');
  if (!values.yes)
    return errorResult(
      'config',
      'reset deletes the snapshot and durable log for this monitor; pass --yes to confirm',
      { at, command: 'reset' },
      format,
    );
  if (!!values['state-file'] === !!values['state-dir'])
    return errorResult(
      'config',
      'exactly one of --state-file or --state-dir is required',
      { at, command: 'reset' },
      format,
    );
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitor = validateMonitorId(monitorId);
  if (!monitor.ok) return errorResult('config', monitor.error, { at, command: 'reset' }, format);
  const entities = parseEntitySelection(values.entities);
  if (!entities.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { at, command: 'reset' },
      format,
    );
  const repo = validateRepo(values.repo);
  if (!repo.ok)
    return errorResult(
      'config',
      values.repo ? repo.error : '--repo is required for reset',
      { at, command: 'reset' },
      format,
    );
  const stateFile =
    values['state-file'] ?? snapshotPath(repo.repo, monitorId, entities.key, values['state-dir']);
  const logFile = resolve(
    deltaLogPath(
      values['state-file']
        ? { stateFile }
        : { stateDir: values['state-dir'], repo: repo.repo, monitorId, entities: entities.key },
    ),
  );
  const lockOpts = { ghTimeoutMs: 60000, staleMs: 600000, fs: lockFs, now: lockNow };
  let token;
  try {
    const acquired = acquireLock(stateFile, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `state file locked (${acquired.reason}): ${stateFile}`,
        { at, command: 'reset' },
        format,
      );
    token = acquired.token;
    deleteSnapshot(stateFile);
    resetDeltaLog(logFile);
    return {
      code: 0,
      format,
      warnings: [],
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'reset',
        stateFile,
        logFile,
        at,
        summary: `reset ${stateFile}`,
      },
    };
  } catch (err) {
    return errorResult(
      err?.code === 'LOCK_LOST' ? 'busy' : err?.kind === 'log' ? 'log' : 'io',
      String(err?.message ?? err),
      { at, command: 'reset' },
      format,
    );
  } finally {
    // Released last: a concurrent tick blocked on this lock is guaranteed to
    // see either the fully-intact pre-reset state or the fully-clean
    // post-reset state, never a half-deleted one.
    if (token) releaseLock(stateFile, token, lockOpts);
  }
}

export { runCompact, runReset };
