// Durable append-only delta journal and consumer cursors. The detector owns
// policy and ordering; this module owns the on-disk NDJSON/cursor contracts.
import {
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  ftruncateSync as nodeFtruncateSync,
  mkdirSync as nodeMkdirSync,
  openSync as nodeOpenSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
  writeSync as nodeWriteSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalEntityKey } from './args.mjs';

function encodeSegment(label, value) {
  return `${label}-${encodeURIComponent(String(value)).replaceAll('_', '%5F')}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function logError(message) {
  const error = new Error(`invalid delta log: ${message}`);
  error.kind = 'log';
  return error;
}

function cursorError(message) {
  const error = new Error(`invalid cursor: ${message}`);
  error.kind = 'log';
  return error;
}

function defaultFs() {
  return {
    closeSync: nodeCloseSync,
    fsyncSync: nodeFsyncSync,
    ftruncateSync: nodeFtruncateSync,
    mkdirSync: nodeMkdirSync,
    openSync: nodeOpenSync,
    readFileSync: nodeReadFileSync,
    renameSync: nodeRenameSync,
    unlinkSync: nodeUnlinkSync,
    writeFileSync: nodeWriteFileSync,
    writeSync: nodeWriteSync,
  };
}

/** Return the one log path associated with a snapshot identity. */
export function deltaLogPath({ stateFile, stateDir, repo, monitorId, entities }) {
  if (stateFile) return `${stateFile}.deltalog.ndjson`;
  return join(
    stateDir,
    `${encodeSegment('log', repo)}__${encodeSegment('monitor', monitorId)}__${canonicalEntityKey(entities)}.ndjson`,
  );
}

function validateRecord(value, expectedSeq, path) {
  if (!isPlainObject(value)) throw logError(`${path}: record must be an object`);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'delta,detectedAt,id,seq')
    throw logError(`${path}: record fields must be exactly seq, id, detectedAt, delta`);
  if (!Number.isSafeInteger(value.seq) || value.seq < 1)
    throw logError(`${path}: seq must be a positive safe integer`);
  if (value.seq !== expectedSeq)
    throw logError(
      `${path}: seq must be strictly contiguous (expected ${expectedSeq}, got ${value.seq})`,
    );
  if (typeof value.id !== 'string' || !isPlainObject(value.delta) || value.delta.id !== value.id)
    throw logError(`${path}: id must equal delta.id`);
  if (
    !['pr', 'issue'].includes(value.delta.entity) ||
    !Number.isSafeInteger(value.delta.number) ||
    value.delta.number <= 0 ||
    !Array.isArray(value.delta.classes) ||
    value.delta.classes.length === 0 ||
    value.delta.classes.some((klass) => typeof klass !== 'string')
  ) {
    throw logError(`${path}: delta must include entity, number, and classes`);
  }
  if (typeof value.detectedAt !== 'string' || !Number.isFinite(Date.parse(value.detectedAt)))
    throw logError(`${path}: detectedAt must be an ISO date string`);
  return value;
}

// Returns only complete records. An unterminated final line is deliberately
// not parsed: it is crash residue and is removed by the next append.
function parseLogText(text, path) {
  const hasPartial = text.length > 0 && !text.endsWith('\n');
  const completeText = hasPartial ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  const entries = [];
  let expectedSeq = 1;
  const completeLines = completeText === '' ? [] : completeText.slice(0, -1).split('\n');
  for (const raw of completeLines) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      throw logError(`${path}: malformed complete JSON line (${error.message})`);
    }
    entries.push(validateRecord(record, expectedSeq, path));
    expectedSeq++;
  }
  return {
    entries,
    trailingPartial: hasPartial,
    completeBytes: Buffer.byteLength(completeText, 'utf8'),
  };
}

function readLog(logFile, fs) {
  let text;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], trailingPartial: false, completeBytes: 0 };
    throw error;
  }
  return parseLogText(text, logFile);
}

/**
 * Append records and fsync the log before the caller publishes its snapshot.
 * A partial final line is cut back to the last newline; complete entries are
 * never altered.
 */
export function appendDeltaLog(logFile, { detectedAt, deltas }, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  if (!Array.isArray(deltas)) throw logError(`${logFile}: deltas must be an array`);
  if (typeof detectedAt !== 'string' || !Number.isFinite(Date.parse(detectedAt)))
    throw logError(`${logFile}: detectedAt must be an ISO date string`);
  const parsed = readLog(logFile, fs);
  const lastSeq = parsed.entries.length;
  if (deltas.length === 0) return { fromSeq: lastSeq + 1, toSeq: lastSeq, appended: 0 };
  const records = deltas.map((delta, index) => {
    if (!isPlainObject(delta) || typeof delta.id !== 'string')
      throw logError(`${logFile}: delta must be an object with id`);
    return { seq: lastSeq + index + 1, id: delta.id, detectedAt, delta };
  });
  // Validate the exact records that would be committed before opening (or
  // recovering) the file. An invalid caller payload must not truncate a crash
  // suffix, append a poison record, or otherwise change existing bytes.
  records.forEach((record, index) => validateRecord(record, lastSeq + index + 1, logFile));
  fs.mkdirSync(dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, parsed.trailingPartial ? 'r+' : 'a');
  try {
    if (parsed.trailingPartial) fs.ftruncateSync(fd, parsed.completeBytes);
    const bytes = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        parsed.trailingPartial ? parsed.completeBytes + offset : undefined,
      );
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { fromSeq: lastSeq + 1, toSeq: lastSeq + records.length, appended: records.length };
}

/** Read all complete records after `afterSeq`, while scanning the whole tail. */
export function readDeltaLog(logFile, { afterSeq = 0, select = () => true } = {}, deps = {}) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
    throw logError(`${logFile}: afterSeq must be a non-negative safe integer`);
  if (typeof select !== 'function') throw logError(`${logFile}: select must be a function`);
  const parsed = readLog(logFile, { ...defaultFs(), ...(deps.fs ?? {}) });
  const lastSeq = parsed.entries.length;
  return {
    entries: parsed.entries.filter((entry) => entry.seq > afterSeq && select(entry)),
    scannedTo: lastSeq,
    firstSeq: lastSeq === 0 ? null : 1,
    lastSeq,
    trailingPartial: parsed.trailingPartial,
  };
}

function validateCursor(value, path) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'cursorVersion,logFile,seq')
    throw cursorError(`${path}: fields must be exactly cursorVersion, logFile, seq`);
  if (value.cursorVersion !== 1) throw cursorError(`${path}: cursorVersion must be 1`);
  if (typeof value.logFile !== 'string' || !isAbsolute(value.logFile))
    throw cursorError(`${path}: logFile must be absolute`);
  if (!Number.isSafeInteger(value.seq) || value.seq < 0)
    throw cursorError(`${path}: seq must be a non-negative safe integer`);
  return value;
}

/** Read and validate an existing consumer cursor. */
export function readCursor(cursorPath, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  let raw;
  try {
    raw = fs.readFileSync(cursorPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validateCursor(JSON.parse(raw), cursorPath);
  } catch (error) {
    if (error?.kind === 'log') throw error;
    throw cursorError(`${cursorPath}: malformed JSON (${error.message})`);
  }
}

/** Atomically replace one cursor file after validating its binding and seq. */
export function setCursorAtomic(cursorPath, cursor, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  validateCursor(cursor, cursorPath);
  fs.mkdirSync(dirname(cursorPath), { recursive: true });
  const tmp = `${cursorPath}.${deps.uniqueSuffix?.() ?? `${process.pid}.${randomUUID()}`}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor));
  try {
    fs.renameSync(tmp, cursorPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename error is authoritative; cleanup is best effort.
    }
    throw error;
  }
}
