import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (p) => JSON.parse(readFileSync(resolve(import.meta.dirname, '..', p), 'utf8'));

// Agent Plugins 1.0 schema is closed (additionalProperties: false); embedded to avoid network.
const ALLOWED = [
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
];

test('all plugin manifests carry the package.json version', () => {
  const { version } = read('package.json');
  for (const p of ['.claude-plugin/plugin.json', 'plugin.json', '.cursor-plugin/plugin.json']) {
    assert.equal(read(p).version, version, p);
  }
});

test('root plugin.json satisfies the Agent Plugins 1.0 closed schema keys', () => {
  const m = read('plugin.json');
  assert.equal(m.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(m.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.deepEqual(
    Object.keys(m).filter((k) => !ALLOWED.includes(k)),
    [],
  );
  assert.equal(m.description, read('.claude-plugin/plugin.json').description);
});

test('.cursor-plugin skills path points at an existing directory', () => {
  const m = read('.cursor-plugin/plugin.json');
  assert.equal(m.name, 'gh-delta');
  const dir = resolve(import.meta.dirname, '..', m.skills);
  assert.ok(existsSync(dir) && statSync(dir).isDirectory(), m.skills);
});

test('.cursor-plugin logo is a committed SVG referenced by relative path', () => {
  const m = read('.cursor-plugin/plugin.json');
  assert.equal(m.logo, 'assets/logo.svg');
  const file = resolve(import.meta.dirname, '..', m.logo);
  assert.ok(existsSync(file) && statSync(file).isFile(), m.logo);
  const svg = readFileSync(file, 'utf8');
  assert.match(svg, /^<svg[^>]*viewBox="0 0 128 128"/);
  assert.doesNotMatch(svg, /<text|<image|@font-face|href=/, 'logo must be self-contained paths');
});
