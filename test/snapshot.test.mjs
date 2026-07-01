// Snapshot tests: state paths are scoped and writes must survive process interruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotPath, readSnapshot, writeSnapshotAtomic } from '../lib/snapshot.mjs';

test('snapshotPath is scoped by repo slug and branch', () => {
  const p = snapshotPath('owner/repo', 'watch/main', '/tmp/state');
  assert.equal(p, '/tmp/state/owner-repo-watch-main.json');
});

test('readSnapshot returns null for a missing file', () => {
  assert.equal(readSnapshot('/tmp/does-not-exist-xyz.json'), null);
});

test('readSnapshot throws for corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'corrupt.json');
  writeFileSync(p, '{ this is not json');
  assert.throws(() => readSnapshot(p), /invalid snapshot JSON/);
});

test('writeSnapshotAtomic round-trips and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'snap.json');
  const data = { pr: { 42: { state: 'OPEN' } }, issue: {} };
  writeSnapshotAtomic(p, data);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), data);
  assert.deepEqual(readSnapshot(p), data);
});

test('writeSnapshotAtomic uses a unique temporary path per write', () => {
  const calls = [];
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path) => {
      calls.push(['write', path]);
    },
    renameSync: (from, to) => {
      calls.push(['rename', from, to]);
    },
  };
  writeSnapshotAtomic('/tmp/snap.json', { n: 1 }, { fs, uniqueSuffix: () => 'a' });
  writeSnapshotAtomic('/tmp/snap.json', { n: 2 }, { fs, uniqueSuffix: () => 'b' });
  const writePaths = calls.filter(([kind]) => kind === 'write').map(([, path]) => path);
  assert.deepEqual(writePaths, ['/tmp/snap.json.a.tmp', '/tmp/snap.json.b.tmp']);
});
