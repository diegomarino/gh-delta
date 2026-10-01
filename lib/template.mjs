import { createHash } from 'node:crypto';
import {
  closeSync as nodeClose,
  lstatSync as nodeLstat,
  openSync as nodeOpen,
  readSync as nodeReadSync,
  realpathSync as nodeRealpath,
} from 'node:fs';
import { TextDecoder } from 'node:util';

const LABEL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const RESERVED = new Set(['until', 'repo', 'constructor', 'prototype']);
const MAX_FILE_BYTES = 4098;
const FILE_READ_CAP = MAX_FILE_BYTES + 1;
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

const FROM_TO_SCALARS = [
  'state',
  'updatedAt',
  'isDraft',
  'headSha',
  'baseRef',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'conversationComments',
  'reviewComments',
];
const FROM_TO_ARRAYS = ['labels', 'assignees', 'reviewRequests'];

const ARRAY_PATHS = new Set([
  'classes',
  'enrichment.body.mentions',
  ...FROM_TO_ARRAYS.flatMap((field) => [`from.${field}`, `to.${field}`]),
]);

export const TEMPLATE_PATHS = new Set([
  'id',
  'repo',
  'entity',
  'number',
  'missingTicks',
  'firstObserved',
  'seq',
  'summaryLine',
  'staleAt',
  'classes',
  'context.id',
  'context.title',
  'context.url',
  'context.author',
  'context.createdAt',
  'context.headRefName',
  'summary.ciRollup',
  'summary.reviewDecision',
  'summary.mergeable',
  'summary.mergeStateStatus',
  'summary.state',
  'summary.isDraft',
  'summary.unresolvedReviewThreads',
  'summary.headSha',
  'enrichment.body.body',
  'enrichment.body.mentions',
  ...FROM_TO_SCALARS.flatMap((field) => [`from.${field}`, `to.${field}`]),
  ...FROM_TO_ARRAYS.flatMap((field) => [`from.${field}`, `to.${field}`]),
]);

export function compileTemplate(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('template must be non-empty');
  if (Buffer.byteLength(text, 'utf8') > 4096) throw new Error('template exceeds 4096 bytes');
  if (CONTROL.test(text)) throw new Error('template contains a disallowed control character');
  const ops = [];
  let i = 0;
  let literal = '';
  const flush = () => {
    if (literal) ops.push({ type: 'literal', text: literal });
    literal = '';
  };
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      literal += '{';
      i += 2;
      continue;
    }
    if (text.startsWith('}}', i)) {
      literal += '}';
      i += 2;
      continue;
    }
    if (text[i] === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) throw new Error('template has an unmatched brace');
      const path = text.slice(i + 1, end);
      if (path.length === 0 || /\s/.test(path) || path.includes('{') || path.includes('}'))
        throw new Error(`template placeholder is invalid: ${path}`);
      flush();
      ops.push({ type: 'path', path, kind: pathKind(path) });
      i = end + 1;
      continue;
    }
    if (text[i] === '}') throw new Error('template has an unmatched brace');
    literal += text[i];
    i += 1;
  }
  flush();
  return (delta) =>
    ops
      .map((op) => (op.type === 'literal' ? op.text : substitute(delta, op.path, op.kind)))
      .join('');
}

function pathKind(path) {
  if (path.startsWith('watch.labels.')) {
    const key = path.slice('watch.labels.'.length);
    if (!LABEL_KEY.test(key) || RESERVED.has(key))
      throw new Error(`template label key is invalid: ${key}`);
    return 'label';
  }
  if (!TEMPLATE_PATHS.has(path)) throw new Error(`template path is unknown: ${path}`);
  return ARRAY_PATHS.has(path) ? 'array' : 'scalar';
}

function substitute(delta, path, kind) {
  if (kind === 'label') {
    const key = path.slice('watch.labels.'.length);
    const watch = own(delta, 'watch');
    const labels = own(watch, 'labels');
    return formatLeaf(own(labels, key), 'scalar');
  }
  const value = readPath(delta, path);
  return formatLeaf(value, kind);
}

function own(object, key) {
  if (object == null || typeof object !== 'object') return undefined;
  if (!Object.hasOwn(object, key)) return undefined;
  return object[key];
}

function readPath(delta, path) {
  let current = delta;
  for (const segment of path.split('.')) {
    current = own(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

function formatLeaf(value, kind) {
  if (value == null) return '';
  if (kind === 'array') {
    if (!Array.isArray(value)) throw new Error('template value is not a primitive');
    if (value.length === 0) return '';
    return value.map((item) => formatLeaf(item, 'scalar')).join(',');
  }
  if (typeof value === 'object') throw new Error('template value is not a primitive');
  return escapeValue(value);
}

function escapeValue(value) {
  return (
    String(value)
      .replaceAll('\\', '\\\\')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t')
      // eslint-disable-next-line no-control-regex -- matching control chars is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, (ch) => {
        return `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`;
      })
  );
}

export function renderTemplateLines(compiled, deltas) {
  if (!deltas?.length) return '';
  return `${deltas.map((delta) => compiled(delta)).join('\n')}\n`;
}

export function assertTemplateDeltas(compiled, deltas) {
  if (!compiled) return;
  for (const delta of deltas ?? []) compiled(delta);
}

function readTemplateBytes(resolved, options) {
  if (options.readFileSync && options.openSync === undefined) return options.readFileSync(resolved);
  const openSync = options.openSync ?? nodeOpen;
  const readSync = options.readSync ?? nodeReadSync;
  const closeSync = options.closeSync ?? nodeClose;
  const fd = openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(FILE_READ_CAP);
    const n = readSync(fd, buf, 0, FILE_READ_CAP, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function loadTemplateFile(path, options = {}) {
  const lstatSync = options.lstatSync ?? nodeLstat;
  const realpathSync = options.realpathSync ?? nodeRealpath;
  if (path === '-' || /^[a-z]+:\/\//i.test(path))
    throw new Error('template file must be a local file');
  const stat = lstatSync(path);
  const resolved = stat.isSymbolicLink() ? realpathSync(path) : path;
  const finalStat = resolved === path ? stat : lstatSync(resolved);
  if (!finalStat.isFile()) throw new Error('template file must be a regular file');
  const bytes = readTemplateBytes(resolved, options);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('template file exceeds 4098 bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (options.expectedSha256 !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(options.expectedSha256))
      throw new Error('template sha256 must be 64 hexadecimal digits');
    if (options.expectedSha256.toLowerCase() !== sha256)
      throw new Error('template sha256 does not match the file bytes');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error('template file must be UTF-8 without a BOM');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('template file must be UTF-8');
  }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  return { text, compiled: compileTemplate(text), sha256 };
}
