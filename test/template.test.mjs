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
