// Snapshot tests: state paths are scoped and writes must survive process interruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotPath,
  readSnapshot,
  writeSnapshotAtomic,
  horizonCutoff,
  defaultStateDir,
} from '../lib/snapshot.mjs';

test('snapshotPath is collision-free for repo and monitor ids that slug the same', () => {
  const a = snapshotPath('a/b-c', 'm', 'pr', '/tmp/state');
  const b = snapshotPath('a-b/c', 'm', 'pr', '/tmp/state');
  const c = snapshotPath('owner/repo', 'prs/fast', 'pr', '/tmp/state');
  const d = snapshotPath('owner/repo', 'prs-fast', 'pr', '/tmp/state');

  assert.notEqual(a, b);
  assert.notEqual(c, d);
  assert.match(a, /^\/tmp\/state\/repo-/);
  assert.match(a, /__monitor-/);
  assert.match(a, /__pr\.json$/);
});

test('snapshotPath uses canonical entity order for combined monitors', () => {
  const p = snapshotPath('owner/repo', 'all', 'issue,pr', '/tmp/state');
  assert.match(p, /__pr-issue\.json$/);
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

test('readSnapshot throws for valid JSON with invalid snapshot shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'wrong-shape.json');
  writeFileSync(p, '[]');
  assert.throws(() => readSnapshot(p), /invalid snapshot shape/);
});

test('readSnapshot accepts only plain pr and issue maps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'snap.json');
  writeFileSync(p, JSON.stringify({ pr: { 42: { state: 'OPEN' } }, issue: {} }));
  assert.deepEqual(readSnapshot(p), { pr: { 42: { state: 'OPEN' } }, issue: {} });

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ pr: [], issue: {} }));
  assert.throws(() => readSnapshot(bad), /invalid snapshot shape/);
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
  writeSnapshotAtomic('/tmp/snap.json', { pr: {}, issue: {} }, { fs, uniqueSuffix: () => 'a' });
  writeSnapshotAtomic('/tmp/snap.json', { pr: {}, issue: {} }, { fs, uniqueSuffix: () => 'b' });
  const writePaths = calls.filter(([kind]) => kind === 'write').map(([, path]) => path);
  assert.deepEqual(writePaths, ['/tmp/snap.json.a.tmp', '/tmp/snap.json.b.tmp']);
});

test('snapshots round-trip an optional meta.horizon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'meta.json');
  const data = { pr: {}, issue: {}, meta: { horizon: '2026-07-01T12:00:00.000Z' } };
  writeSnapshotAtomic(p, data);
  assert.deepEqual(readSnapshot(p), data);
});

test('horizonCutoff derives from meta, falls back to fingerprints, honors overlap', () => {
  assert.equal(horizonCutoff(null), null);
  assert.equal(
    horizonCutoff({ pr: {}, issue: {}, meta: { horizon: '2026-07-01T12:05:00.000Z' } }),
    '2026-07-01T12:00:00.000Z', // default 5-minute overlap
  );
  assert.equal(
    horizonCutoff({
      pr: { 42: { state: 'OPEN', updatedAt: '2026-07-01T10:05:00.000Z' } },
      issue: {},
    }),
    '2026-07-01T10:00:00.000Z', // legacy: max fingerprint updatedAt
  );
  assert.equal(horizonCutoff({ pr: {}, issue: {} }), null); // empty legacy: open-only tick
});

test('snapshot filenames are injective across the __monitor- boundary', () => {
  const a = snapshotPath('a/b', 'c__monitor-d', 'pr', '/x');
  const b = snapshotPath('a/b__monitor-c', 'd', 'pr', '/x');
  assert.notEqual(a, b);
});

test('defaultStateDir derives a per-user dir under the system tmpdir', () => {
  const dir = defaultStateDir({ tmpdir: () => '/tmp-x', userInfo: () => ({ username: 'a_b' }) });
  assert.equal(dir, '/tmp-x/gh-delta-a%5Fb');
  const fallback = defaultStateDir({
    tmpdir: () => '/t',
    userInfo: () => {
      throw new Error('no user db entry');
    },
    env: { USER: 'env-user' },
  });
  assert.equal(fallback, '/t/gh-delta-env-user');
});

test('writeSnapshotAtomic forwards dirMode to mkdir', () => {
  const opts = [];
  const fs = {
    mkdirSync: (_path, options) => opts.push(options),
    writeFileSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
  };
  writeSnapshotAtomic(
    '/tmp/snap.json',
    { pr: {}, issue: {} },
    { fs, uniqueSuffix: () => 'a', dirMode: 0o700 },
  );
  writeSnapshotAtomic('/tmp/snap.json', { pr: {}, issue: {} }, { fs, uniqueSuffix: () => 'b' });
  assert.equal(opts[0].mode, 0o700);
  assert.equal('mode' in opts[1], false);
});

test('writeSnapshotAtomic validates shape before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  assert.throws(
    () => writeSnapshotAtomic(join(dir, 'bad.json'), { pr: [], issue: {} }),
    /invalid snapshot shape/,
  );
});

test('writeSnapshotAtomic removes the temp file when rename fails', () => {
  const calls = [];
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path) => calls.push(['write', path]),
    renameSync: () => {
      throw new Error('EXDEV');
    },
    unlinkSync: (path) => calls.push(['unlink', path]),
  };
  assert.throws(
    () =>
      writeSnapshotAtomic('/tmp/snap.json', { pr: {}, issue: {} }, { fs, uniqueSuffix: () => 'a' }),
    /EXDEV/,
  );
  assert.deepEqual(calls, [
    ['write', '/tmp/snap.json.a.tmp'],
    ['unlink', '/tmp/snap.json.a.tmp'],
  ]);
});
