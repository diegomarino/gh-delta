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

test('package publishes only the gh-delta bin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(pkg.bin, { 'gh-delta': './gh-delta.mjs' });
  assert.equal(pkg.exports['./tick'], undefined);
  assert.ok(!pkg.files.includes('gh-delta-tick.mjs'));
});
