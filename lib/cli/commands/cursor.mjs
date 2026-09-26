import {
  acquireLock as fsAcquireLock,
  assertLockOwned as fsAssertLockOwned,
  extendLockDeadline as fsExtendLockDeadline,
  releaseLock as fsReleaseLock,
} from '../../lock.mjs';
import {
  readCursor as fsReadCursor,
  readDeltaLog as fsReadDeltaLog,
  setCursorAtomic as fsSetCursorAtomic,
} from '../../deltalog.mjs';
import {
  commandHelp,
  READ_OPTIONS,
  formatSniff,
  parseDeltaClassSelection,
  positiveInt,
  CURSOR_SET_OPTIONS,
  nonNegativeInt,
} from '../parse.mjs';
import { parseArgs } from 'node:util';
import { errorResult } from '../errors.mjs';
import { resolve } from 'node:path';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';

// Cursor scans are local, synchronous filesystem work. These fixed leases are
// intentionally independent of GitHub's fetch timeout and are renewed once
// after a scan, immediately before a cursor replacement.
const CURSOR_LOCK_TIMEOUT_MS = 5000;

const CURSOR_LOCK_STALE_MS = 30000;

function cursorLockOptions(cursorLockFs, cursorLockNow) {
  return {
    ghTimeoutMs: CURSOR_LOCK_TIMEOUT_MS,
    staleMs: CURSOR_LOCK_STALE_MS,
    ...(cursorLockFs ? { fs: cursorLockFs } : {}),
    now: cursorLockNow,
  };
}

// Consumer-side replay: no GitHub, snapshot, registry, or cursor write unless
// --advance is requested. That mutation path takes a cursor-local lock.
function runRead(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    readCursor = fsReadCursor,
    readDeltaLog = fsReadDeltaLog,
    releaseLock = fsReleaseLock,
    setCursorAtomic = fsSetCursorAtomic,
    cursorLockFs,
    cursorLockNow = () => Date.now(),
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta read');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: READ_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'read' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult('config', '--format must be json or text', { at, command: 'read' }, 'json');
  if (!values.cursor)
    return errorResult('config', '--cursor is required', { at, command: 'read' }, format);
  const cursorPath = resolve(values.cursor);
  const only = parseDeltaClassSelection('--only-classes', values['only-classes']);
  if (!only.ok) return errorResult('config', only.error, { at, command: 'read' }, format);
  let number;
  if (values.number !== undefined) {
    number = positiveInt('--number', values.number);
    if (number.error) return errorResult('config', number.error, { at, command: 'read' }, format);
  }
  const lockOpts = cursorLockOptions(cursorLockFs, cursorLockNow);
  let lockToken;
  if (values.advance) {
    let acquired;
    try {
      acquired = acquireLock(cursorPath, lockOpts);
    } catch (err) {
      return errorResult('io', String(err?.message ?? err), { at, command: 'read' }, format);
    }
    if (!acquired.ok)
      return errorResult(
        'busy',
        `cursor locked (${acquired.reason}): ${cursorPath}`,
        { at, command: 'read' },
        format,
      );
    lockToken = acquired.token;
  }
  try {
    let cursor;
    try {
      cursor = readCursor(cursorPath);
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'read' },
        format,
      );
    }
    if (!cursor)
      return errorResult(
        'log',
        `cursor file does not exist: ${cursorPath}`,
        { at, command: 'read' },
        format,
      );
    let scanned;
    try {
      scanned = readDeltaLog(cursor.logFile, {
        afterSeq: cursor.seq,
        select: (entry) =>
          (only.classes.length === 0 ||
            entry.delta.classes?.some((klass) => only.classes.includes(klass))) &&
          (number === undefined || entry.delta.number === number.value),
      });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'read' },
        format,
      );
    }
    if (cursor.seq > scanned.lastSeq) {
      return errorResult(
        'log',
        `cursor seq ${cursor.seq} is above complete log tail ${scanned.lastSeq}: ${cursor.logFile}`,
        { at, command: 'read' },
        format,
      );
    }
    const warnings =
      cursor.seq + 1 < scanned.firstSeq
        ? [{ label: 'retention', reason: 'cursor behind retention' }]
        : [];
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'read',
      logFile: cursor.logFile,
      at,
      cursor: { path: cursorPath, from: cursor.seq, to: scanned.scannedTo, advanced: false },
      deltas: scanned.entries.map((entry) => entry.delta),
      summary: `${scanned.entries.length} delta(s)`,
    };
    if (values.advance) {
      try {
        extendLockDeadline(cursorPath, lockToken, lockOpts);
        if (!assertLockOwned(cursorPath, lockToken, lockOpts))
          return errorResult(
            'busy',
            `cursor lock lost before advance: ${cursorPath}`,
            { at, command: 'read' },
            format,
          );
        setCursorAtomic(cursorPath, {
          cursorVersion: 1,
          logFile: cursor.logFile,
          seq: scanned.scannedTo,
        });
      } catch (err) {
        return errorResult(
          err?.kind === 'log' ? 'log' : 'io',
          String(err?.message ?? err),
          { at, command: 'read' },
          format,
        );
      }
      report.cursor.advanced = true;
    }
    return { code: report.deltas.length ? 10 : 0, report, format, warnings };
  } finally {
    if (lockToken) releaseLock(cursorPath, lockToken, lockOpts);
  }
}

function runCursorSet(argv, deps = {}) {
  const {
    acquireLock = fsAcquireLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    readCursor = fsReadCursor,
    readDeltaLog = fsReadDeltaLog,
    releaseLock = fsReleaseLock,
    setCursorAtomic = fsSetCursorAtomic,
    cursorLockFs,
    cursorLockNow = () => Date.now(),
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  const help = commandHelp(argv, 'gh-delta cursor set');
  if (help) return { code: 0, report: help, format: 'json' };
  if (argv.length < 2)
    return errorResult(
      'config',
      'cursor set requires <cursor-path> <seq>',
      { at, command: 'cursor set' },
      formatSniff(argv),
    );
  const [rawCursorPath, rawSeq, ...optionArgs] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: optionArgs, options: CURSOR_SET_OPTIONS }));
  } catch (err) {
    return errorResult(
      'config',
      String(err?.message ?? err),
      { at, command: 'cursor set' },
      formatSniff(argv),
    );
  }
  const format = values.format;
  if (format !== 'json' && format !== 'text')
    return errorResult(
      'config',
      '--format must be json or text',
      { at, command: 'cursor set' },
      'json',
    );
  const seq = nonNegativeInt('<seq>', rawSeq);
  if (seq.error) return errorResult('config', seq.error, { at, command: 'cursor set' }, format);
  const cursorPath = resolve(rawCursorPath);
  const lockOpts = cursorLockOptions(cursorLockFs, cursorLockNow);
  let lockToken;
  try {
    const acquired = acquireLock(cursorPath, lockOpts);
    if (!acquired.ok)
      return errorResult(
        'busy',
        `cursor locked (${acquired.reason}): ${cursorPath}`,
        { at, command: 'cursor set' },
        format,
      );
    lockToken = acquired.token;
  } catch (err) {
    return errorResult('io', String(err?.message ?? err), { at, command: 'cursor set' }, format);
  }
  try {
    let existing;
    try {
      existing = readCursor(cursorPath);
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    if (!existing && !values['log-file'])
      return errorResult(
        'config',
        '--log-file is required to initialize a cursor',
        { at, command: 'cursor set' },
        format,
      );
    const logFile = values['log-file'] ? resolve(values['log-file']) : existing.logFile;
    if (existing && values['log-file'] && logFile !== existing.logFile)
      return errorResult(
        'config',
        '--log-file must match the existing cursor binding',
        { at, command: 'cursor set' },
        format,
      );
    let scanned;
    try {
      scanned = readDeltaLog(logFile, { afterSeq: 0 });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    if (seq.value > scanned.lastSeq)
      return errorResult(
        'log',
        `cursor seq ${seq.value} is above complete log tail ${scanned.lastSeq}: ${logFile}`,
        { at, command: 'cursor set' },
        format,
      );
    try {
      extendLockDeadline(cursorPath, lockToken, lockOpts);
      if (!assertLockOwned(cursorPath, lockToken, lockOpts))
        return errorResult(
          'busy',
          `cursor lock lost before set: ${cursorPath}`,
          { at, command: 'cursor set' },
          format,
        );
      setCursorAtomic(cursorPath, { cursorVersion: 1, logFile, seq: seq.value });
    } catch (err) {
      return errorResult(
        err?.kind === 'log' ? 'log' : 'io',
        String(err?.message ?? err),
        { at, command: 'cursor set' },
        format,
      );
    }
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'cursor set',
      at,
      cursor: { path: cursorPath, logFile, from: existing?.seq ?? 0, to: seq.value },
      summary: `cursor set to ${seq.value}`,
    };
    return { code: 0, report, format, warnings: [] };
  } finally {
    if (lockToken) releaseLock(cursorPath, lockToken, lockOpts);
  }
}

export { runRead, runCursorSet };
