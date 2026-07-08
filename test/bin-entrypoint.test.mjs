// Bin entrypoint tests: npm/npx invokes package bins through .bin symlinks.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function symlinkedBin(scriptName) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-bin-'));
  const link = join(dir, scriptName.replace(/\.mjs$/, ''));
  symlinkSync(fileURLToPath(new URL(`../${scriptName}`, import.meta.url)), link);
  return link;
}

test('gh-delta starts when invoked through an npm-style bin symlink', () => {
  const output = execFileSync(process.execPath, [symlinkedBin('gh-delta.mjs'), '--help'], {
    encoding: 'utf8',
  });

  assert.match(output, /^Usage:\n {2}gh-delta --repo/);
  assert.doesNotMatch(output, /gh-delta-tick/);
});

test('package root import is intentionally not exported', async () => {
  await assert.rejects(() => import('gh-delta'), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test('package publishes only the gh-delta bin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(pkg.bin, { 'gh-delta': 'gh-delta.mjs' });
  assert.equal(pkg.exports['.'], undefined);
  assert.equal(pkg.exports['./tick'], undefined);
  assert.ok(!pkg.files.includes('gh-delta-tick.mjs'));
});

test('package includes README image assets referenced by docs', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('docs/img'));
});

test('gh-delta/contract exposes the runtime contract constants', async () => {
  const contract = await import('gh-delta/contract');
  assert.equal(contract.REPORT_SCHEMA_VERSION, 1);
  assert.equal(contract.OUTPOST_SCHEMA_VERSION, 1);
  assert.ok(Object.isFrozen(contract.DELTA_CLASSES));
  assert.ok(contract.DELTA_CLASSES.includes('first-seen'));
  assert.ok(contract.DELTA_CLASSES.includes('presumed-deleted'));
  assert.ok(Object.isFrozen(contract.REPORT_FIELDS));
  assert.ok(contract.REPORT_FIELDS.includes('warnings'));
  assert.ok(Object.isFrozen(contract.DELTA_FIELDS));
  assert.ok(contract.DELTA_FIELDS.includes('summaryLine'));
  assert.ok(contract.DELTA_FIELDS.includes('line'));
  assert.ok(contract.DELTA_FIELDS.includes('details'));
  assert.ok(Object.isFrozen(contract.DELTA_DETAIL_FIELDS));
  assert.ok(contract.DELTA_DETAIL_FIELDS.includes('opaque'));
  assert.ok(Object.isFrozen(contract.DELTA_DETAIL_FIELDS_BY_CLASS));
  assert.deepEqual(contract.DELTA_DETAIL_FIELDS_BY_CLASS['new-comments'], ['comments']);
  assert.deepEqual(contract.DELTA_DETAIL_FIELDS_BY_CLASS.relabeled, ['labels']);
  assert.deepEqual(contract.ERROR_KINDS, ['config', 'snapshot', 'github', 'io']);
});
