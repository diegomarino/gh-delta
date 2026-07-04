// Entrypoint detection tests: never a silent no-op when path resolution fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isDirectEntrypoint } from '../lib/entrypoint.mjs';

test('literal path equality wins when realpath fails', () => {
  const missing = '/nonexistent/gh-delta.mjs';
  const metaUrl = `file://${missing}`;
  const warned = [];
  assert.equal(
    isDirectEntrypoint(metaUrl, missing, (m) => warned.push(m)),
    true,
  );
  assert.deepEqual(warned, []);
});

test('ambiguous resolution warns on stderr and does not start', () => {
  const warned = [];
  const result = isDirectEntrypoint('file:///nonexistent/a.mjs', '/nonexistent/b.mjs', (m) =>
    warned.push(m),
  );
  assert.equal(result, false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /cannot resolve entrypoint paths/);
});

test('a real module compared against itself stays quiet', () => {
  const self = fileURLToPath(import.meta.url);
  const warned = [];
  assert.equal(
    isDirectEntrypoint(import.meta.url, self, (m) => warned.push(m)),
    true,
  );
  assert.deepEqual(warned, []);
});
