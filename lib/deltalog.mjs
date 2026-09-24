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
import { basename, dirname, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
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
  if (keys.join(',') !== 'delta,detectedAt,id,monitorId,repo,seq')
    throw logError(
      `${path}: record fields must be exactly seq, id, detectedAt, delta, repo, monitorId`,
    );
  if (!Number.isSafeInteger(value.seq) || value.seq < 1)
    throw logError(`${path}: seq must be a positive safe integer`);
  if (value.seq !== expectedSeq)
    throw logError(
      `${path}: seq must be strictly contiguous (expected ${expectedSeq}, got ${value.seq})`,
    );
  if (typeof value.id !== 'string' || !isPlainObject(value.delta) || value.delta.id !== value.id)
    throw logError(`${path}: id must equal delta.id`);
  if (typeof value.repo !== 'string' || value.repo.length === 0)
    throw logError(`${path}: repo must be a non-empty string`);
  if (typeof value.monitorId !== 'string' || value.monitorId.length === 0)
    throw logError(`${path}: monitorId must be a non-empty string`);
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

// Returns only complete records. Boundaries are raw byte offsets: decoding
// invalid UTF-8 must never turn one input byte into replacement bytes and a
// manifest offset that points past the durable file.
function parseLogBytes(rawBytes, path, expectedSeq = 1) {
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const hasPartial = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  const completeBytes = hasPartial ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
  let completeText;
  try {
    completeText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, completeBytes),
    );
  } catch {
    throw logError(`${path}: invalid UTF-8 in complete record`);
  }
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
    completeBytes,
  };
}

function publicationManifestPath(logFile) {
  return `${logFile}.published.json`;
}

// Manifest v3 is the only supported generation: `firstSeq`, `lastSeq`,
// `byteLength`, `dataFile`. There is no reader for the older v1 (bootstrap,
// implicit dataFile === logFile) or v2 (firstSeq, still implicit dataFile)
// manifests, and no migration -- an older manifest is rejected with a message
// naming `gh-delta reset` as the documented recovery.
function validateManifest(value, path) {
  if (!isPlainObject(value)) throw logError(`${path}: manifest must be an object`);
  const keys = Object.keys(value).sort().join(',');
  if (value.version !== 3 || keys !== 'byteLength,dataFile,firstSeq,lastSeq,version')
    throw logError(
      `${path}: unsupported manifest version ${JSON.stringify(value.version)}; only the schema-v2 version-3 manifest is readable -- run \`gh-delta reset\` to start a clean baseline`,
    );
  if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0)
    throw logError(`${path}: lastSeq must be a non-negative safe integer`);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0)
    throw logError(`${path}: byteLength must be a non-negative safe integer`);
  const firstSeq = value.firstSeq;
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1 || firstSeq > value.lastSeq + 1)
    throw logError(`${path}: firstSeq must be between 1 and lastSeq + 1`);
  if (typeof value.dataFile !== 'string' || basename(value.dataFile) !== value.dataFile)
    throw logError(`${path}: dataFile must be a same-directory filename`);
  return { ...value, firstSeq };
}

function dataPath(logFile, manifest) {
  return manifest?.version === 3 ? join(dirname(logFile), manifest.dataFile) : logFile;
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

// A log file with bytes but no manifest predates the schema-v2 version-3
// manifest format (either the pre-manifest raw-NDJSON era, or a v1/v2
// manifest that was itself deleted/lost). There is no bootstrap path for it
// any more -- only `gh-delta reset`.
function assertNoUnmanifestedLog(logFile, fs) {
  const size = logSize(logFile, fs);
  if (size !== null) {
    throw logError(
      `${logFile}: log predates the schema-v2 manifest format; run \`gh-delta reset\` to start a clean baseline`,
    );
  }
}

function inspectLogForAppend(logFile, fs) {
  const manifest = readManifest(logFile, fs);
  if (!manifest) assertNoUnmanifestedLog(logFile, fs);
  const activeFile = dataPath(logFile, manifest);
  const size = logSize(activeFile, fs);
  if (manifest) {
    if (size === null && manifest.byteLength !== 0)
      throw logError(`${logFile}: manifest is ahead of the log`);
    if (size !== null && size < manifest.byteLength)
      throw logError(`${logFile}: manifest is ahead of the log`);
    // A published manifest is the writer's trust boundary. Ordinary append
    // validates only the uncommitted suffix; readers always validate below.
    const suffix = parseLogBytes(
      size === null
        ? Buffer.alloc(0)
        : readRange(activeFile, manifest.byteLength, size - manifest.byteLength, fs),
      activeFile,
      manifest.lastSeq + 1,
    );
    return {
      manifest,
      activeFile,
      baseByteLength: manifest.byteLength,
      baseLastSeq: manifest.lastSeq,
      suffix,
      size,
    };
  }
  // No manifest and no file: a fresh log. The first append below publishes
  // the first-ever manifest (version 3, dataFile === basename(logFile)).
  return {
    manifest: null,
    baseByteLength: 0,
    baseLastSeq: 0,
    suffix: { entries: [], trailingPartial: false, completeBytes: 0 },
    size: 0,
    activeFile: logFile,
  };
}

function publishedLog(logFile, fs) {
  const manifest = readManifest(logFile, fs);
  if (!manifest) {
    assertNoUnmanifestedLog(logFile, fs);
    return { entries: [], firstSeq: null, lastSeq: 0, byteLength: 0 };
  }
  const activeFile = dataPath(logFile, manifest);
  const size = logSize(activeFile, fs);
  if (size === null && manifest.byteLength !== 0) {
    const error = logError(`${logFile}: manifest is ahead of the log`);
    if (manifest.version === 3) error.code = 'GENERATION_MISSING';
    throw error;
  }
  if (size !== null && size < manifest.byteLength)
    throw logError(`${logFile}: manifest is ahead of the log`);
  const prefix =
    size === null ? Buffer.alloc(0) : readRange(activeFile, 0, manifest.byteLength, fs);
  const parsed = parseLogBytes(prefix, activeFile, manifest.firstSeq);
  if (parsed.trailingPartial || parsed.completeBytes !== manifest.byteLength)
    throw logError(`${logFile}: manifest byteLength does not end at a complete record`);
  if (parsed.entries.length !== manifest.lastSeq - manifest.firstSeq + 1)
    throw logError(`${logFile}: manifest sequence bounds do not match the published prefix`);
  return {
    entries: parsed.entries,
    firstSeq: manifest.firstSeq,
    lastSeq: manifest.lastSeq,
    byteLength: manifest.byteLength,
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
  // Windows FlushFileBuffers requires a writable handle; r+ is non-truncating.
  const fd = fs.openSync(logFile, 'r+');
  try {
    assertMutationAllowed(logFile, verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncManifestDirectory(logFile, fs, deps) {
  const manifest = publicationManifestPath(logFile);
  const win32 = (deps.platform ?? process.platform) === 'win32';
  // Node core cannot open a portable writable Windows directory handle. Sync
  // the final renamed manifest there; POSIX still persists the parent entry.
  const target = win32 ? manifest : dirname(manifest);
  const flags = win32 ? 'r+' : 'r';
  assertMutationAllowed(logFile, deps.verifyBeforeMutation);
  const fd = fs.openSync(target, flags);
  try {
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
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
  // Do not fold this into rename cleanup: at this point the manifest is already
  // published and must survive a directory-fsync failure for safe recovery.
  fsyncManifestDirectory(logFile, fs, deps);
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
  // Publish the first-ever manifest (fresh log, no manifest yet) and promote
  // any complete post-manifest suffix. It is safe to promote because the
  // suffix was validated contiguously and the log has been synced before the
  // atomic manifest rename.
  if (
    !inspected.manifest ||
    inspected.suffix.entries.length > 0 ||
    inspected.suffix.trailingPartial
  ) {
    // Nothing to sync on a from-scratch bootstrap (no manifest, no prior
    // bytes at all -- `logFile` doesn't exist yet). Only a genuine unpublished
    // suffix recovered from an existing file needs its fsync repeated here.
    if (!inspected.suffix.trailingPartial && inspected.suffix.entries.length > 0)
      fsyncLog(logFile, fs, deps.verifyBeforeMutation);
    publishManifest(
      logFile,
      inspected.manifest
        ? {
            version: 3,
            firstSeq: inspected.manifest.firstSeq,
            dataFile: inspected.manifest.dataFile,
            lastSeq: recoveredLastSeq,
            byteLength: cleanByteLength,
          }
        : {
            version: 3,
            firstSeq: 1,
            dataFile: basename(logFile),
            lastSeq: recoveredLastSeq,
            byteLength: cleanByteLength,
          },
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
export function appendDeltaLog(logFile, { detectedAt, deltas, repo, monitorId }, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  if (!Array.isArray(deltas)) throw logError(`${logFile}: deltas must be an array`);
  if (typeof detectedAt !== 'string' || !Number.isFinite(Date.parse(detectedAt)))
    throw logError(`${logFile}: detectedAt must be an ISO date string`);
  if (typeof repo !== 'string' || repo.length === 0)
    throw logError(`${logFile}: repo must be a non-empty string`);
  if (typeof monitorId !== 'string' || monitorId.length === 0)
    throw logError(`${logFile}: monitorId must be a non-empty string`);
  const inspected = inspectLogForAppend(logFile, fs);
  const activeFile = inspected.activeFile;
  const lastSeq = inspected.baseLastSeq + inspected.suffix.entries.length;
  if (deltas.length === 0) return { fromSeq: lastSeq + 1, toSeq: lastSeq, appended: 0 };
  const records = deltas.map((delta, index) => {
    if (!isPlainObject(delta) || typeof delta.id !== 'string')
      throw logError(`${logFile}: delta must be an object with id`);
    return { seq: lastSeq + index + 1, id: delta.id, detectedAt, delta, repo, monitorId };
  });
  const bytes = serializeValidatedRecords(records, lastSeq, logFile);
  fs.mkdirSync(dirname(activeFile), { recursive: true });
  // The producer extends its lease at the append boundary. It is followed by
  // a fence before opening and again directly before every content mutation;
  // a steal can still land in a syscall-sized gap, just as snapshot rename has
  // its own documented residual gap.
  deps.onProgress?.();
  const recovered = recoverForAppend(activeFile, inspected, fs, deps);
  assertMutationAllowed(activeFile, deps.verifyBeforeMutation);
  const fd = fs.openSync(activeFile, inspected.suffix.trailingPartial ? 'r+' : 'a');
  try {
    if (inspected.suffix.trailingPartial) {
      assertMutationAllowed(activeFile, deps.verifyBeforeMutation);
      fs.ftruncateSync(fd, recovered.byteLength);
    }
    let offset = 0;
    while (offset < bytes.length) {
      assertMutationAllowed(activeFile, deps.verifyBeforeMutation);
      offset += fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        inspected.suffix.trailingPartial ? recovered.byteLength + offset : undefined,
      );
    }
    assertMutationAllowed(activeFile, deps.verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  publishManifest(
    logFile,
    {
      version: 3,
      firstSeq: inspected.manifest?.firstSeq ?? 1,
      dataFile: inspected.manifest?.dataFile ?? basename(activeFile),
      lastSeq: lastSeq + records.length,
      byteLength: recovered.byteLength + bytes.length,
    },
    fs,
    deps,
  );
  return { fromSeq: lastSeq + 1, toSeq: lastSeq + records.length, appended: records.length };
}

/** Read all complete records after `afterSeq`, while scanning the whole tail. */
function readDeltaLogOnce(logFile, { afterSeq = 0, select = () => true } = {}, deps = {}) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
    throw logError(`${logFile}: afterSeq must be a non-negative safe integer`);
  if (typeof select !== 'function') throw logError(`${logFile}: select must be a function`);
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  const published = publishedLog(logFile, fs);
  const { entries: allEntries, firstSeq, lastSeq } = published;
  if (afterSeq > lastSeq) throw logError(`${logFile}: afterSeq is above published tail`);
  return {
    entries: allEntries.filter((entry) => entry.seq > afterSeq && select(entry)),
    scannedTo: lastSeq,
    firstSeq: lastSeq === 0 ? null : firstSeq,
    lastSeq,
    trailingPartial: false,
  };
}

/** Read one stable manifest generation; retry once if retention cleanup races a reader. */
export function readDeltaLog(logFile, options = {}, deps = {}) {
  try {
    return readDeltaLogOnce(logFile, options, deps);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'GENERATION_MISSING') throw error;
    return readDeltaLogOnce(logFile, options, deps);
  }
}

/** Atomically replace the published prefix with the selected retained records. */
export function compactDeltaLog(logFile, { keep }, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  if (
    !isPlainObject(keep) ||
    !((Number.isSafeInteger(keep.count) && keep.count >= 0) || Number.isSafeInteger(keep.sinceMs))
  )
    throw logError(`${logFile}: compact keep policy is invalid`);
  const published = publishedLog(logFile, fs);
  const previousFile = dataPath(logFile, readManifest(logFile, fs));
  let retained;
  if (Number.isSafeInteger(keep.count)) {
    retained = published.entries.slice(Math.max(0, published.entries.length - keep.count));
  } else {
    // Sequence continuity is the storage invariant. If the wall clock moves
    // backward, keep everything after the first in-window record rather than
    // selecting later records independently and creating sequence holes.
    const firstRetained = published.entries.findIndex(
      (entry) => Date.parse(entry.detectedAt) >= keep.sinceMs,
    );
    retained = firstRetained === -1 ? [] : published.entries.slice(firstRetained);
  }
  const firstSeq = retained.length ? retained[0].seq : published.lastSeq + 1;
  const bytes = Buffer.from(
    retained.map((entry) => JSON.stringify(entry)).join(retained.length ? '\n' : '') +
      (retained.length ? '\n' : ''),
    'utf8',
  );
  fs.mkdirSync(dirname(logFile), { recursive: true });
  deps.onProgress?.();
  assertMutationAllowed(logFile, deps.verifyBeforeMutation);
  const generation = `${basename(logFile)}.generation.${deps.uniqueSuffix?.() ?? `${process.pid}.${randomUUID()}`}.ndjson`;
  const tmp = join(dirname(logFile), `${generation}.tmp`);
  const generationFile = join(dirname(logFile), generation);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    let offset = 0;
    while (offset < bytes.length) {
      deps.onProgress?.();
      assertMutationAllowed(logFile, deps.verifyBeforeMutation);
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    // Publish an immutable generation through the manifest; readers see either
    // manifest generation and never a missing root log window.
    deps.onProgress?.();
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    fs.renameSync(tmp, generationFile);
    fsyncLog(generationFile, fs, deps.verifyBeforeMutation);
    deps.onProgress?.();
    assertMutationAllowed(logFile, deps.verifyBeforeMutation);
    publishManifest(
      logFile,
      {
        version: 3,
        dataFile: generation,
        firstSeq,
        lastSeq: published.lastSeq,
        byteLength: bytes.length,
      },
      fs,
      deps,
    );
    // Retain at most the currently published generation; stale legacy/current
    // files are best-effort cleanup and readers retry when a raced file vanishes.
    if (previousFile !== generationFile)
      try {
        fs.unlinkSync(previousFile);
      } catch {
        // A raced reader or prior cleanup makes this harmless.
      }
  } catch (error) {
    let generationIsPublished = true;
    try {
      const current = readManifest(logFile, fs);
      generationIsPublished =
        current?.version === 3 && current.dataFile === basename(generationFile);
    } catch {
      // If publication state is unreadable, preserve the generation. Deleting
      // it could turn a successfully renamed manifest into permanent damage.
    }
    if (!generationIsPublished) {
      try {
        fs.unlinkSync(generationFile);
      } catch {
        // The unpublished generation is best-effort cleanup.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return {
    previous: {
      firstSeq: published.entries.length ? published.firstSeq : null,
      lastSeq: published.lastSeq,
      count: published.entries.length,
    },
    retained: {
      firstSeq: retained.length ? firstSeq : null,
      lastSeq: retained.length ? published.lastSeq : null,
      count: retained.length,
    },
  };
}

/**
 * Delete a monitor's durable delta log entirely: the published manifest and
 * its bound data file (or the bare log file, if no manifest was ever
 * published). Idempotent -- a clean monitor (nothing on disk) is a no-op.
 * Used by `gh-delta reset`, which holds the monitor lock for the whole
 * operation and releases it last so a concurrent tick cannot interleave with
 * a half-deleted log.
 */
export function resetDeltaLog(logFile, deps = {}) {
  const fs = { ...defaultFs(), ...(deps.fs ?? {}) };
  let manifest = null;
  try {
    manifest = readManifest(logFile, fs);
  } catch {
    // An unreadable manifest (corrupt, or an unsupported older version) does
    // not block reset -- fall back to the bare log file and still clean up.
  }
  const dataFile = dataPath(logFile, manifest);
  for (const file of new Set([dataFile, logFile])) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  try {
    fs.unlinkSync(publicationManifestPath(logFile));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
