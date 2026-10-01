import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileTemplate,
  loadTemplateFile,
  renderTemplateLines,
  TEMPLATE_PATHS,
} from '../lib/template.mjs';
import { DELTA_CONTEXT_FIELDS, DELTA_SUMMARY_FIELDS } from '../lib/contract.mjs';

const delta = {
  id: 'abc',
  repo: 'owner/repo',
  entity: 'pr',
  number: 42,
  classes: ['ci-changed', 'new-comments'],
  context: { title: 'hello\nthere', author: 'octo' },
  summary: { state: 'open', isDraft: false, unresolvedReviewThreads: 0 },
  watch: { labels: { 'task.id': 't-0004', thread: 't-0004' } },
};

test('compileTemplate renders the issue examples and escapes values', () => {
  const line = compileTemplate('{entity} #{number} [{classes}]');
  assert.equal(line(delta), 'pr #42 [ci-changed,new-comments]');
  const labeled = compileTemplate(
    '{watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}',
  );
  assert.equal(labeled(delta), 't-0004: owner/repo #42 {state=open}');
  assert.equal(compileTemplate('{watch.labels.missing}')(delta), '');
  assert.equal(
    compileTemplate('{summary.isDraft} {summary.unresolvedReviewThreads}')(delta),
    'false 0',
  );
  assert.equal(compileTemplate('{context.title}')(delta), 'hello\\nthere');
  assert.equal(renderTemplateLines(line, []), '');
  assert.equal(renderTemplateLines(line, [delta]), 'pr #42 [ci-changed,new-comments]\n');
  assert.equal(compileTemplate('{summaryLine}')({}), '');
  assert.equal(compileTemplate('{from.state}')({ from: { state: 'open' } }), 'open');
  assert.equal(
    compileTemplate('{enrichment.body.mentions}')({
      enrichment: { body: { mentions: ['a', 'b'] } },
    }),
    'a,b',
  );
});

test('compileTemplate rejects unknown paths, controls, and object parents before data is required', () => {
  for (const text of [
    '{summary.typo}',
    '{context}',
    '{summary.failedChecks}',
    '{watch.labels.}',
    '{watch.labels.until}',
    '{\n}',
    'a\nb',
    '{{id}',
    '{id}}',
  ])
    assert.throws(() => compileTemplate(text), /template/i, text);
  assert.throws(() => compileTemplate(''), /template/i);
  assert.throws(
    () => compileTemplate('{classes}').call(null, { classes: [{ name: 'bug' }] }),
    /template/i,
  );
});

test('loadTemplateFile hashes raw bytes before stripping one trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-file-'));
  const path = join(dir, 'line.txt');
  const raw = '{entity} #{number}\n';
  writeFileSync(path, raw);
  const digest = createHash('sha256').update(Buffer.from(raw)).digest('hex');
  const loaded = loadTemplateFile(path, { expectedSha256: digest.toUpperCase() });
  assert.equal(loaded.sha256, digest);
  assert.equal(loaded.text, '{entity} #{number}');
  assert.equal(loaded.compiled({ entity: 'pr', number: 1, classes: ['new'] }), 'pr #1');
  assert.throws(() => loadTemplateFile(path, { expectedSha256: 'a'.repeat(64) }), /sha256|digest/i);
  writeFileSync(path, `{entity}\n\n`);
  assert.throws(() => loadTemplateFile(path), /template/i);
});

test('loadTemplateFile rejects directories, malformed digests, and oversized buffers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-dir-'));
  assert.throws(() => loadTemplateFile(dir), /regular file|template file/i);
  const path = join(dir, 'ok.txt');
  writeFileSync(path, '{entity}');
  assert.throws(() => loadTemplateFile(path, { expectedSha256: 'abc' }), /64|hex|sha256/i);
  const oversize = Buffer.alloc(4099, 0x61);
  assert.throws(
    () =>
      loadTemplateFile(path, {
        lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
        readFileSync: () => oversize,
      }),
    /4098/i,
  );
});

test('loadTemplateFile reads at most 4099 bytes from the file descriptor', () => {
  let requested = 0;
  const loaded = loadTemplateFile('line.txt', {
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    openSync: () => 3,
    fstatSync: () => ({ isFile: () => true }),
    readSync: (_fd, buf, _offset, length) => {
      requested = length;
      const src = Buffer.from('{entity}');
      src.copy(buf);
      return src.length;
    },
    closeSync: () => {},
  });
  assert.equal(requested, 4099);
  assert.equal(loaded.text, '{entity}');
});

test('TEMPLATE_PATHS stays aligned with contract context and summary scalars', () => {
  for (const field of DELTA_CONTEXT_FIELDS)
    assert.ok(TEMPLATE_PATHS.has(`context.${field}`), `context.${field}`);
  for (const field of DELTA_SUMMARY_FIELDS) {
    if (field === 'failedChecks') {
      assert.equal(TEMPLATE_PATHS.has('summary.failedChecks'), false);
      continue;
    }
    assert.ok(TEMPLATE_PATHS.has(`summary.${field}`), `summary.${field}`);
  }
});

test('all allowlisted paths render absent, null, scalar and array values', () => {
  const arrays = new Set([
    'classes',
    'enrichment.body.mentions',
    ...['from', 'to'].flatMap((parent) =>
      ['labels', 'assignees', 'reviewRequests'].map((key) => `${parent}.${key}`),
    ),
  ]);
  for (const path of TEMPLATE_PATHS) {
    const render = compileTemplate(`{${path}}`);
    assert.equal(render({}), '', path);
    const data = {};
    let current = data;
    const parts = path.split('.');
    for (const part of parts.slice(0, -1)) current = current[part] = {};
    const leaf = parts.at(-1);
    current[leaf] = null;
    assert.equal(render(data), '', path);
    current[leaf] = arrays.has(path) ? ['a,b', null, 0, false] : false;
    assert.equal(render(data), arrays.has(path) ? 'a,b,,0,false' : 'false', path);
    current[leaf] = {};
    assert.throws(() => render(data), /primitive/, path);
  }
});

test('grammar rejects indexing, nesting and prototype access and treats backslashes literally', () => {
  for (const path of [
    'details',
    'from.checks[0].name',
    'summary.failedChecks.0',
    'watch.labels.__proto__',
    'watch.labels.constructor',
    'watch.labels.prototype',
    'watch.labels.repo',
    'watch.labels.until',
    'watch.labels.1x',
    'context.__proto__',
  ])
    assert.throws(() => compileTemplate(`{${path}}`), /template/);
  for (const text of ['{', '}', '{}', '{ id}', '{id }', '{a{b}}'])
    assert.throws(() => compileTemplate(text), /template/);
  assert.equal(compileTemplate('{{{number}}} \\n')({ number: 42 }), '{42} \\n');
  assert.equal(
    compileTemplate('{watch.labels.task-id}')({ watch: { labels: { 'task-id': 't1' } } }),
    't1',
  );
  assert.equal(
    compileTemplate('{watch.labels.task.id}')({ watch: { labels: { task: { id: 'wrong' } } } }),
    '',
  );
  assert.equal(
    compileTemplate('{watch.labels.task.id}')({
      watch: { labels: Object.create({ 'task.id': 'inherited' }) },
    }),
    '',
  );
  assert.equal(
    renderTemplateLines(compileTemplate('{summary.state}'), [{ summary: null }, {}]),
    '\n\n',
  );
});

test('template byte bounds and substituted controls are exact', () => {
  assert.equal(compileTemplate('a'.repeat(4096))({}).length, 4096);
  assert.equal(compileTemplate('é'.repeat(2048))({}).length, 2048);
  assert.throws(() => compileTemplate('a'.repeat(4097)), /4096/);
  assert.throws(() => compileTemplate('é'.repeat(2048) + 'a'), /4096/);
  for (const code of [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => 127 + i),
    0x2028,
    0x2029,
  ]) {
    const ch = String.fromCharCode(code);
    assert.throws(() => compileTemplate(`a${ch}b`), /control/);
    const expected =
      code === 10
        ? '\\n'
        : code === 13
          ? '\\r'
          : code === 9
            ? '\\t'
            : `\\u${code.toString(16).padStart(4, '0')}`;
    assert.equal(compileTemplate('{context.title}')({ context: { title: ch } }), expected);
    assert.equal(
      compileTemplate('{enrichment.body.body}')({ enrichment: { body: { body: ch } } }),
      expected,
    );
  }
  assert.equal(
    compileTemplate('{context.title}')({ context: { title: '\\{number}"é' } }),
    '\\\\{number}"é',
  );
});

test('file normalization, encodings, symlinks and non-regular inputs obey the contract', async () => {
  const { symlinkSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-boundaries-'));
  try {
    const path = join(dir, 'line');
    const link = join(dir, 'link');
    symlinkSync(path, link);
    for (const ending of ['', '\n', '\r\n']) {
      writeFileSync(path, 'é'.repeat(2048) + ending);
      assert.equal(loadTemplateFile(link).text, 'é'.repeat(2048));
    }
    for (const raw of [
      '',
      '\n',
      '\r\n',
      '{id}\n\n',
      '\uFEFF{id}',
      Buffer.from([0xc3, 0x28]),
      'a'.repeat(4097),
      'a'.repeat(4097) + '\r\n',
    ]) {
      writeFileSync(path, raw);
      assert.throws(() => loadTemplateFile(path), /template|UTF-8|BOM|4096|4098/);
    }
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    for (const invalid of [
      '-',
      'https://example.com/template',
      dir,
      fifo,
      '/dev/null',
      join(dir, 'missing'),
    ])
      assert.throws(() => loadTemplateFile(invalid), /local file|regular file|ENOENT/);
    assert.throws(
      () =>
        loadTemplateFile(path, {
          openSync: () => {
            const err = new Error('denied');
            err.code = 'EACCES';
            throw err;
          },
        }),
      /denied/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('published 58-byte hash fixture pins accepted bytes across replacement', async () => {
  const { rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-pin-'));
  const path = join(dir, 'coordinator.txt');
  try {
    const raw = 'thread={watch.labels.thread} {repo} #{number} [{classes}]\n';
    const digest = 'eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba';
    assert.equal(Buffer.byteLength(raw), 58);
    writeFileSync(path, raw);
    const loaded = loadTemplateFile(path, { expectedSha256: digest });
    writeFileSync(path, '{summary.typo}');
    assert.equal(loaded.compiled(delta), 'thread=t-0004 owner/repo #42 [ci-changed,new-comments]');
    for (const changed of [
      raw.replace('\n', '\r\n'),
      raw.trimEnd(),
      raw.replace('thread=', 'task='),
    ]) {
      writeFileSync(path, changed);
      assert.throws(() => loadTemplateFile(path, { expectedSha256: digest }), /sha256/);
    }
    writeFileSync(path, raw);
    for (const hash of ['', 'g'.repeat(64), 'a'.repeat(63)])
      assert.throws(() => loadTemplateFile(path, { expectedSha256: hash }), /64 hexadecimal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replacing a checked template with a FIFO cannot block the loader', async () => {
  const { spawnSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-fifo-race-'));
  const path = join(dir, 'line');
  writeFileSync(path, '{id}');
  try {
    const script = `
      import { loadTemplateFile } from ${JSON.stringify(new URL('../lib/template.mjs', import.meta.url).href)};
      import { lstatSync, unlinkSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      try {
        loadTemplateFile(${JSON.stringify(path)}, { lstatSync: (name) => {
          const stat = lstatSync(name); unlinkSync(name); execFileSync('mkfifo', [name]); return stat;
        }});
        process.exitCode = 1;
      } catch (err) {
        if (!/regular file/.test(err.message)) throw err;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 1500,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
