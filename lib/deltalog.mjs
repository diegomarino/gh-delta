// Durable append-only delta journal and consumer cursors. The detector owns
// policy and ordering; this module owns the on-disk NDJSON/cursor contracts.
import {
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  ftruncateSync as nodeFtruncateSync,
  mkdirSync as nodeMkdirSync,
  openSync as nodeOpenSync,
  readFileSync as nodeReadFileSync,
  readSync as nodeReadSync,
  renameSync as nodeRenameSync,
  statSync as nodeStatSync,
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

function lockLost(logFile) {
  const error = new Error(`ownership check failed before delta log mutation for ${logFile}`);
  error.code = 'LOCK_LOST';
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
    readSync: nodeReadSync,
    renameSync: nodeRenameSync,
    statSync: nodeStatSync,
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

function parseLogTextFromSeq(text, path, expectedSeq) {
  const hasPartial = text.length > 0 && !text.endsWith('\n');
  const completeText = hasPartial ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  const entries = [];
  const completeLines = completeText === '' ? [] : completeText.slice(0, -1).split('\n');
  for (const raw of completeLines) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      throw logError(`${path}: malformed complete JSON line (${error.message})`);
    }
    entries.push(validateRecord(record, expectedSeq + entries.length, path));
  }
  return {
    entries,
    trailingPartial: hasPartial,
    completeBytes: Buffer.byteLength(completeText, 'utf8'),
  };
}

function publicationManifestPath(logFile) {
  return `${logFile}.published.json`;
}

function validateManifest(value, path) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'byteLength,lastSeq,version')
    throw logError(`${path}: fields must be exactly version, lastSeq, byteLength`);
  if (value.version !== 1) throw logError(`${path}: version must be 1`);
  if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0)
    throw logError(`${path}: lastSeq must be a non-negative safe integer`);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0)
    throw logError(`${path}: byteLength must be a non-negative safe integer`);
  return value;
}

function readManifest(logFile, fs) {
  const path = publicationManifestPath(logFile);
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validateManifest(JSON.parse(raw), path);
  } catch (error) {
    if (error?.kind === 'log') throw error;
    throw logError(`${path}: malformed JSON (${error.message})`);
  }
}

function logSize(logFile, fs) {
  try {
    return fs.statSync(logFile).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readRange(logFile, start, length, fs) {
  if (length === 0) return Buffer.alloc(0);
  const fd = fs.openSync(logFile, 'r');
  try {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, bytes, offset, length - offset, start + offset);
      if (read === 0) throw logError(`${logFile}: changed while reading`);
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readLegacyLog(logFile, fs) {
  let text;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], trailingPartial: false, completeBytes: 0 };
    throw error;
  }
  return parseLogText(text, logFile);
}

function inspectLogForAppend(logFile, fs) {
  const manifest = readManifest(logFile, fs);
  const size = logSize(logFile, fs);
  if (manifest) {
    if (size === null || size < manifest.byteLength)
      throw logError(`${logFile}: manifest is ahead of the log`);
    // A published manifest is the writer's trust boundary. Ordinary append
    // validates only the uncommitted suffix; readers always validate below.
    const suffix = parseLogTextFromSeq(
      readRange(logFile, manifest.byteLength, size - manifest.byteLength, fs).toString('utf8'),
      logFile,
      manifest.lastSeq + 1,
    );
    return {
      manifest,
      hadLegacyLog: false,
      baseByteLength: manifest.byteLength,
      baseLastSeq: manifest.lastSeq,
      suffix,
      size,
    };
  }
  const legacy = readLegacyLog(logFile, fs);
  return {
    manifest: null,
    hadLegacyLog: size !== null,
    baseByteLength: 0,
    baseLastSeq: 0,
    suffix: legacy,
    size: size ?? 0,
  };
}

// The disk contract is the JSON representation, not merely the caller's
// object graph: JSON.stringify turns sparse arrays into nulls, for example.
// Validate the parsed bytes through the same reader validator before opening
// or recovering the log, so append cannot commit a record its reader rejects.
function serializeValidatedRecords(records, lastSeq, logFile) {
  let lines;
  try {
    lines = records.map((record) => JSON.stringify(record));
  } catch (error) {
    throw logError(`${logFile}: record is not JSON serializable (${error.message})`);
  }
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw logError(`${logFile}: record serialization is invalid JSON (${error.message})`);
    }
    validateRecord(parsed, lastSeq + index + 1, logFile);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function assertMutationAllowed(logFile, verifyBeforeMutation) {
  if (verifyBeforeMutation && !verifyBeforeMutation()) throw lockLost(logFile);
}

function fsyncLog(logFile, fs, verifyBeforeMutation) {
  assertMutationAllowed(logFile, verifyBeforeMutation);
  const fd = fs.openSync(logFile, 'r');
  try {
    assertMutationAllowed(logFile, verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The manifest is the reader-visible commit point. Its temp file is synced
// before same-directory rename, so a completed log suffix is never exposed
// until the log itself has been synced first.
function publishManifest(logFile, manifest, fs, deps) {
  const path = publicationManifestPath(logFile);
  const tmp = `${path}.${deps.uniqueSuffix?.() ?? `${process.pid}.${randomUUID()}`}.tmp`;
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  assertMutationAllowed(logFile, deps.verifyBeforeMutation);
  const fd = fs.openSync(tmp, 'w');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    fs.renameSync(tmp, path);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // A failed publish leaves the old boundary authoritative; cleanup is best effort.
    }
    throw error;
  }
}

function recoverForAppend(logFile, inspected, fs, deps) {
  const cleanByteLength = inspected.baseByteLength + inspected.suffix.completeBytes;
  const recoveredLastSeq = inspected.baseLastSeq + inspected.suffix.entries.length;
  if (inspected.suffix.trailingPartial) {
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    const fd = fs.openSync(logFile, 'r+');
    try {
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      fs.ftruncateSync(fd, cleanByteLength);
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  // Bootstrap a legacy file and promote any complete post-manifest suffix.
  // It is safe to promote because the suffix was validated contiguously and
  // the log has been synced before the atomic manifest rename.
  if (
    inspected.hadLegacyLog ||
    inspected.suffix.entries.length > 0 ||
    inspected.suffix.trailingPartial
  ) {
    if (!inspected.suffix.trailingPartial) fsyncLog(logFile, fs, deps.verifyBeforeMutation);
    publishManifest(
      logFile,
      { version: 1, lastSeq: recoveredLastSeq, byteLength: cleanByteLength },
      fs,
      deps,
    );
  }
  return { lastSeq: recoveredLastSeq, byteLength: cleanByteLength };
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
  const inspected = inspectLogForAppend(logFile, fs);
  const lastSeq = inspected.baseLastSeq + inspected.suffix.entries.length;
  if (deltas.length === 0) return { fromSeq: lastSeq + 1, toSeq: lastSeq, appended: 0 };
  const records = deltas.map((delta, index) => {
    if (!isPlainObject(delta) || typeof delta.id !== 'string')
      throw logError(`${logFile}: delta must be an object with id`);
    return { seq: lastSeq + index + 1, id: delta.id, detectedAt, delta };
  });
  const bytes = serializeValidatedRecords(records, lastSeq, logFile);
  fs.mkdirSync(dirname(logFile), { recursive: true });
  // The producer extends its lease at the append boundary. It is followed by
  // a fence before opening and again directly before every content mutation;
  // a steal can still land in a syscall-sized gap, just as snapshot rename has
  // its own documented residual gap.
  deps.onProgress?.();
  const recovered = recoverForAppend(logFile, inspected, fs, deps);
  assertMutationAllowed(logFile, deps.verifyBeforeMutation);
  const fd = fs.openSync(logFile, inspected.suffix.trailingPartial ? 'r+' : 'a');
  try {
    if (inspected.suffix.trailingPartial) {
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      fs.ftruncateSync(fd, recovered.byteLength);
    }
    let offset = 0;
    while (offset < bytes.length) {
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      offset += fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        inspected.suffix.trailingPartial ? recovered.byteLength + offset : undefined,
      );
    }
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  publishManifest(
    logFile,
    {
      version: 1,
      lastSeq: lastSeq + records.length,
      byteLength: recovered.byteLength + bytes.length,
    },
    fs,
    deps,
  );
  return { fromSeq: lastSeq + 1, toSeq: lastSeq + records.length, appended: records.length };
}

/** Read all complete records after `afterSeq`, while scanning the whole tail. */
export function readDeltaLog(logFile, { afterSeq = 0, select = () => true } = {}, deps = {}) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
    throw logError(`${logFile}: afterSeq must be a non-negative safe integer`);
  if (typeof select !== 'function') throw logError(`${logFile}: select must be a function`);
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  const manifest = readManifest(logFile, fs);
  let parsed;
  if (manifest) {
    const size = logSize(logFile, fs);
    if (size === null || size < manifest.byteLength)
      throw logError(`${logFile}: manifest is ahead of the log`);
    parsed = parseLogText(readRange(logFile, 0, manifest.byteLength, fs).toString('utf8'), logFile);
    if (parsed.trailingPartial || parsed.completeBytes !== manifest.byteLength)
      throw logError(`${logFile}: manifest byteLength does not end at a complete record`);
    if (parsed.entries.length !== manifest.lastSeq)
      throw logError(`${logFile}: manifest lastSeq does not match the published prefix`);
  } else {
    parsed = readLegacyLog(logFile, fs);
  }
  const lastSeq = manifest ? manifest.lastSeq : parsed.entries.length;
  if (afterSeq > lastSeq) throw logError(`${logFile}: afterSeq is above published tail`);
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
