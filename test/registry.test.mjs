// Registry tests: breadcrumbs must be idempotent per monitor, tolerant to
// corruption on read, and always safe to delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalStateFileKey,
  defaultRegistryDir,
  readRegistry,
  registerMonitor,
  registryEntryPath,
} from '../lib/registry.mjs';

test('defaultRegistryDir prefers the explicit env override, then XDG, then HOME', () => {
  const homedir = () => '/home/u';
  assert.equal(
    defaultRegistryDir({ env: { GH_DELTA_REGISTRY_DIR: '/custom/reg' }, homedir }),
    '/custom/reg',
  );
  assert.equal(
    defaultRegistryDir({ env: { XDG_STATE_HOME: '/xdg/state' }, homedir }),
    '/xdg/state/gh-delta/registry',
  );
  assert.equal(defaultRegistryDir({ env: {}, homedir }), '/home/u/.local/state/gh-delta/registry');
});

test('registryEntryPath is deterministic per snapshot path and collision-scoped', () => {
  const a = registryEntryPath('/reg', '/state/a.json');
  assert.equal(a, registryEntryPath('/reg', '/state/a.json'));
  assert.notEqual(a, registryEntryPath('/reg', '/state/b.json'));
  assert.match(a, /^\/reg\/[0-9a-f]{16}\.json$/);
});

test('registerMonitor is idempotent: re-registering overwrites its own entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  const env = { GH_DELTA_REGISTRY_DIR: dir };
  const runArgs = {
    repo: 'o/r',
    monitorId: 'prs-5m',
    entities: ['pr'],
    stateFile: '/state/repo-o%2Fr__monitor-prs-5m__pr.json',
    env,
  };
  registerMonitor({ ...runArgs, lastRun: '2026-07-08T11:00:00.000Z' });
  registerMonitor({ ...runArgs, lastRun: '2026-07-08T12:00:00.000Z' });

  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 1);
  const { entries, skippedFiles } = readRegistry(dir);
  assert.equal(skippedFiles, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].registryVersion, 1);
  assert.equal(entries[0].repo, 'o/r');
  assert.equal(entries[0].monitorId, 'prs-5m');
  assert.deepEqual(entries[0].entities, ['pr']);
  assert.equal(entries[0].lastRun, '2026-07-08T12:00:00.000Z');
  assert.equal(entries[0].stateFile, '/state/repo-o%2Fr__monitor-prs-5m__pr.json');
});

test('readRegistry skips corrupt and foreign files instead of failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  registerMonitor({
    repo: 'o/r',
    monitorId: 'ok',
    entities: ['pr'],
    stateFile: '/state/x.json',
    lastRun: '2026-07-08T11:00:00.000Z',
    env: { GH_DELTA_REGISTRY_DIR: dir },
  });
  writeFileSync(join(dir, 'corrupt.json'), '{ nope');
  writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ repo: 'o/r' }));
  writeFileSync(join(dir, 'stray.txt'), 'not an entry');

  const { entries, skippedFiles } = readRegistry(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].monitorId, 'ok');
  assert.equal(skippedFiles, 3);
});

test('readRegistry treats a missing directory as an empty registry', () => {
  assert.deepEqual(readRegistry('/tmp/gd-reg-does-not-exist-xyz'), {
    entries: [],
    skippedFiles: 0,
  });
});

test('canonicalStateFileKey case-folds only on Windows', () => {
  // Same monitor referenced with different casing: one identity on win32
  // (case-insensitive filesystems), two on POSIX (case-sensitive).
  assert.equal(
    canonicalStateFileKey('/State/X.json', 'win32'),
    canonicalStateFileKey('/state/x.json', 'win32'),
  );
  assert.notEqual(
    canonicalStateFileKey('/State/X.json', 'linux'),
    canonicalStateFileKey('/state/x.json', 'linux'),
  );
  assert.equal(
    registryEntryPath('/reg', '/State/X.json', 'win32'),
    registryEntryPath('/reg', '/state/x.json', 'win32'),
  );
  assert.notEqual(
    registryEntryPath('/reg', '/State/X.json', 'linux'),
    registryEntryPath('/reg', '/state/x.json', 'linux'),
  );
});
