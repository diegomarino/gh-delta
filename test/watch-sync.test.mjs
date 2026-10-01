import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  markTerminalIgnored,
  readWatch,
  removeWatch,
  removeWatchUnchanged,
} from '../lib/watch.mjs';
import {
  assertWatchGeneration,
  markManifestTerminalIgnored,
  readWatchGeneration,
  removeManifestEntries,
  syncWatch,
} from '../lib/watch-sync.mjs';

test('syncWatch converts a legacy directory and a second identical sync does not rewrite it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-'));
  const created = addWatch(dir, 'pr:3', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/widgets',
    labels: { thread: 't-0004' },
  });
  const marked = readFileSync(created.path, 'utf8');
  assert.equal(markTerminalIgnored(created.path, marked, '2026-09-30T12:00:00.000Z'), true);
  const text = 'pr:3 until=merged repo=acme/widgets thread=t-0004\nend 1\n';
  const first = syncWatch(dir, text, { now: () => '2026-09-30T13:00:00.000Z' });
  assert.deepEqual(first.unchanged, [{ repo: 'acme/widgets', entity: 'pr', number: 3 }]);
  const manifest = JSON.parse(readFileSync(join(dir, 'watch-set.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.entries[0].addedAt, '2026-09-30T10:00:00.000Z');
  assert.equal(manifest.entries[0].ignoredTerminalAt, '2026-09-30T12:00:00.000Z');
  const bytes = readFileSync(join(dir, 'watch-set.json'), 'utf8');
  const mtime = statSync(join(dir, 'watch-set.json')).mtimeMs;
  const second = syncWatch(dir, text, { now: () => '2026-09-30T14:00:00.000Z' });
  assert.deepEqual(second.unchanged, first.unchanged);
  assert.equal(readFileSync(join(dir, 'watch-set.json'), 'utf8'), bytes);
  assert.equal(statSync(join(dir, 'watch-set.json')).mtimeMs, mtime);
  assert.equal(readWatch(dir)[0].ignoredTerminalAt, '2026-09-30T12:00:00.000Z');
});

test('omitting labels clears them and keeps addedAt and ignoredTerminalAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-clear-labels-'));
  const created = addWatch(dir, 'pr:3', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/widgets',
    labels: { thread: 't-0004' },
  });
  assert.equal(
    markTerminalIgnored(
      created.path,
      readFileSync(created.path, 'utf8'),
      '2026-09-30T12:00:00.000Z',
    ),
    true,
  );
  syncWatch(dir, 'pr:3 until=merged repo=acme/widgets thread=t-0004\nend 1\n', {
    now: () => '2026-09-30T13:00:00.000Z',
  });
  const result = syncWatch(dir, 'pr:3 until=merged repo=acme/widgets\nend 1\n', {
    now: () => '2026-09-30T14:00:00.000Z',
  });
  assert.deepEqual(result.updated, [{ repo: 'acme/widgets', entity: 'pr', number: 3 }]);
  const [entry] = readWatch(dir);
  assert.equal(Object.hasOwn(entry, 'labels'), false);
  assert.equal(entry.addedAt, '2026-09-30T10:00:00.000Z');
  assert.equal(entry.ignoredTerminalAt, '2026-09-30T12:00:00.000Z');
});

test('changing until resets addedAt and drops ignoredTerminalAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-until-'));
  const created = addWatch(dir, 'pr:3', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/widgets',
    labels: { thread: 't-0004' },
  });
  assert.equal(
    markTerminalIgnored(
      created.path,
      readFileSync(created.path, 'utf8'),
      '2026-09-30T12:00:00.000Z',
    ),
    true,
  );
  syncWatch(dir, 'pr:3 until=merged repo=acme/widgets thread=t-0004\nend 1\n', {
    now: () => '2026-09-30T13:00:00.000Z',
  });
  const result = syncWatch(dir, 'pr:3 until=closed repo=acme/widgets thread=t-0004\nend 1\n', {
    now: () => '2026-09-30T15:00:00.000Z',
  });
  assert.deepEqual(result.updated, [{ repo: 'acme/widgets', entity: 'pr', number: 3 }]);
  const [entry] = readWatch(dir);
  assert.equal(entry.until, 'closed');
  assert.equal(entry.addedAt, '2026-09-30T15:00:00.000Z');
  assert.equal(Object.hasOwn(entry, 'ignoredTerminalAt'), false);
});

test('syncWatch replaces the whole directory even when repo is a default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-scope-'));
  addWatch(dir, 'pr:1', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/tools',
  });
  addWatch(dir, 'pr:2', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/widgets',
  });
  const result = syncWatch(dir, 'pr:2 until=merged\nend 1\n', { repo: 'acme/widgets' });
  assert.deepEqual(result.removed, [{ repo: 'acme/tools', entity: 'pr', number: 1 }]);
  assert.deepEqual(result.unchanged, [{ repo: 'acme/widgets', entity: 'pr', number: 2 }]);
});

test('parse failure does not create watch-set.json or change legacy bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-parse-fail-'));
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  const bytes = readFileSync(created.path, 'utf8');
  assert.throws(
    () => syncWatch(dir, 'pr:3 until=merged\npr:4 until=merged\nend 1\n'),
    /watch sync/,
  );
  assert.equal(existsSync(join(dir, 'watch-set.json')), false);
  assert.equal(readFileSync(created.path, 'utf8'), bytes);
});

test('end 0 without allowEmpty does not remove the legacy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-empty-'));
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  assert.throws(() => syncWatch(dir, 'end 0\n'), /allow-empty/);
  assert.equal(existsSync(created.path), true);
});

test('leftover per-entry files are not part of a manifest set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-sidecar-'));
  addWatch(dir, 'pr:3', 'merged', {
    now: () => '2026-09-30T10:00:00.000Z',
    repo: 'acme/widgets',
  });
  syncWatch(dir, 'pr:3 until=merged repo=acme/widgets\nend 1\n');
  writeFileSync(
    join(dir, 'pr-9.json'),
    '{"entity":"pr","number":9,"until":"merged","addedAt":"2026-09-30T10:00:00.000Z"}\n',
  );
  const entries = readWatch(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].number, 3);
});

test('a corrupt manifest does not fall back to leftover files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-corrupt-'));
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  syncWatch(dir, 'pr:3 until=merged\nend 1\n');
  writeFileSync(join(dir, 'watch-set.json'), '{');
  assert.throws(() => readWatch(dir), /invalid watch entry watch-set.json/);
  assert.equal(existsSync(created.path), true);
});

test('removeWatchUnchanged throws on a manifest directory and leaves bytes equal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-path-mut-'));
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  const legacyBytes = readFileSync(created.path, 'utf8');
  syncWatch(dir, 'pr:3 until=merged\nend 1\n');
  const manifestBytes = readFileSync(join(dir, 'watch-set.json'), 'utf8');
  assert.throws(
    () => removeWatchUnchanged(created.path, legacyBytes),
    /watch sync manifest does not support path mutation/,
  );
  assert.equal(readFileSync(join(dir, 'watch-set.json'), 'utf8'), manifestBytes);
});

test('assertWatchGeneration throws WATCH_DIR_BUSY after a generation change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-generation-'));
  syncWatch(dir, 'pr:42 until=merged\nend 1\n', { now: () => '2026-09-30T10:00:00.000Z' });
  const { generation } = readWatchGeneration(dir);
  assert.equal(typeof generation, 'string');
  syncWatch(dir, 'pr:1 until=merged\nend 1\n', { now: () => '2026-09-30T11:00:00.000Z' });
  assert.throws(
    () => assertWatchGeneration(dir, generation),
    (err) => err.code === 'WATCH_DIR_BUSY',
  );
});

test('manifest cleanup removes every eligible identity in one generation bump', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-cleanup-'));
  syncWatch(dir, 'pr:1 until=merged\npr:2 until=merged\npr:3 until=merged\nend 3\n', {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  const { generation } = readWatchGeneration(dir);
  assert.throws(
    () =>
      removeManifestEntries(
        dir,
        [
          { entity: 'pr', number: 1 },
          { entity: 'pr', number: 2 },
          { entity: 'pr', number: 3 },
        ],
        'not-this-generation',
      ),
    (err) => err.code === 'WATCH_DIR_BUSY',
  );
  assert.equal(readWatch(dir).length, 3);
  const next = removeManifestEntries(
    dir,
    [
      { entity: 'pr', number: 1 },
      { entity: 'pr', number: 2 },
      { entity: 'pr', number: 3 },
    ],
    generation,
  );
  assert.notEqual(next, generation);
  assert.equal(readWatch(dir).length, 0);
  const after = JSON.parse(readFileSync(join(dir, 'watch-set.json'), 'utf8'));
  assert.equal(after.generation, next);
});

test('syncWatch creates nested watch directories', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'gd-sync-nested-')), 'deeper', 'watch');
  const result = syncWatch(dir, 'pr:3 until=merged\nend 1\n', {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  assert.equal(result.added.length, 1);
  assert.equal(existsSync(join(dir, 'watch-set.json')), true);
});

test('addWatch and removeWatch mutate a manifest and keep path logical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-add-manifest-'));
  syncWatch(dir, 'pr:3 until=merged\nend 1\n', { now: () => '2026-09-30T10:00:00.000Z' });
  const added = addWatch(dir, 'pr:9', 'merged', { now: () => '2026-09-30T11:00:00.000Z' });
  assert.equal(added.added, true);
  assert.equal(existsSync(added.path), false);
  assert.equal(readWatch(dir).length, 2);
  const removed = removeWatch(dir, 'pr:3');
  assert.equal(removed.removed, true);
  assert.deepEqual(
    readWatch(dir).map((entry) => entry.number),
    [9],
  );
});

test('markTerminalIgnored throws on a manifest directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-mark-mut-'));
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  const bytes = readFileSync(created.path, 'utf8');
  syncWatch(dir, 'pr:3 until=merged\nend 1\n');
  const manifestBytes = readFileSync(join(dir, 'watch-set.json'), 'utf8');
  assert.throws(
    () => markTerminalIgnored(created.path, bytes, '2026-09-30T12:00:00.000Z'),
    /watch sync manifest does not support path mutation/,
  );
  assert.equal(readFileSync(join(dir, 'watch-set.json'), 'utf8'), manifestBytes);
});

test('markManifestTerminalIgnored rejects a stale generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-mark-gen-'));
  syncWatch(dir, 'pr:3 until=merged\nend 1\n', { now: () => '2026-09-30T10:00:00.000Z' });
  assert.throws(
    () =>
      markManifestTerminalIgnored(
        dir,
        [{ entity: 'pr', number: 3 }],
        '2026-09-30T12:00:00.000Z',
        'stale',
      ),
    (err) => err.code === 'WATCH_DIR_BUSY',
  );
  assert.equal(Object.hasOwn(readWatch(dir)[0], 'ignoredTerminalAt'), false);
});

test('manifest readers and sync reject duplicate identities without rewriting state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-duplicate-manifest-'));
  syncWatch(dir, 'pr:3 until=merged\nend 1\n');
  const path = join(dir, 'watch-set.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.entries.push({ ...manifest.entries[0], until: 'closed' });
  const damaged = JSON.stringify(manifest);
  writeFileSync(path, damaged);
  assert.throws(() => readWatch(dir), /invalid watch entry watch-set.json/);
  assert.throws(() => readWatchGeneration(dir), /invalid watch entry watch-set.json/);
  assert.throws(
    () => syncWatch(dir, 'pr:3 until=merged\nend 1\n'),
    /invalid watch entry watch-set.json/,
  );
  assert.equal(readFileSync(path, 'utf8'), damaged);
});
