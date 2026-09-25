// Snapshot tests: state paths are scoped and writes must survive process interruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotPath,
  economicalSnapshotPath,
  readSnapshot,
  writeSnapshotAtomic,
  horizonCutoff,
  defaultStateDir,
} from '../lib/snapshot.mjs';

// Schema v2 item shape: `{ fingerprint, context, meta }` -- see
// docs/contract.md "Snapshot Semantics" and lib/detect.mjs.
const item = (fingerprint = { state: 'OPEN' }, context = {}, meta = {}) => ({
  fingerprint,
  context,
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
    ...meta,
  },
});

// Schema v2 snapshot-wide meta is mandatory and exactly this field set -- see
// lib/snapshot.mjs's validateSnapshotMeta.
const meta = (overrides = {}) => ({
  schemaVersion: 2,
  ghDeltaVersion: '0.0.0-test',
  repo: 'owner/repo',
  monitorId: 'm',
  entities: ['pr', 'issue'],
  scope: 'poll',
  horizon: '2026-07-01T12:00:00.000Z',
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
  ...overrides,
});

test('economical snapshot paths are distinct for derived and explicit state', () => {
  const ordinary = snapshotPath('owner/repo', 'main', 'pr-issue', '/tmp/state');
  const economical = economicalSnapshotPath('owner/repo', 'main', 'pr-issue', '/tmp/state');
  assert.match(economical, /__watch-pr\.json$/);
  assert.notEqual(economical, ordinary);
  assert.equal(
    economicalSnapshotPath(null, null, null, null, { stateFile: '/tmp/custom.json' }),
    '/tmp/custom.json.watch.json',
  );
});

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

test('readSnapshot accepts only plain pr and issue maps of three-section items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'snap.json');
  const data = { pr: { 42: item() }, issue: {}, meta: meta() };
  writeFileSync(p, JSON.stringify(data));
  assert.deepEqual(readSnapshot(p), data);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ pr: [], issue: {}, meta: meta() }));
  assert.throws(() => readSnapshot(bad), /invalid snapshot shape/);
});

test('readSnapshot rejects a v1/legacy snapshot (missing or pre-schema-v2 meta) naming reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));

  const noMeta = join(dir, 'no-meta.json');
  writeFileSync(noMeta, JSON.stringify({ pr: { 42: item() }, issue: {} }));
  assert.throws(() => readSnapshot(noMeta), /gh-delta reset/);

  const v1Meta = join(dir, 'v1-meta.json');
  writeFileSync(
    v1Meta,
    JSON.stringify({ pr: { 42: item() }, issue: {}, meta: { horizon: '2026-07-01T12:00:00Z' } }),
  );
  assert.throws(() => readSnapshot(v1Meta), /gh-delta reset/);

  const wrongVersion = join(dir, 'wrong-version.json');
  writeFileSync(
    wrongVersion,
    JSON.stringify({ pr: { 42: item() }, issue: {}, meta: meta({ schemaVersion: 1 }) }),
  );
  assert.throws(() => readSnapshot(wrongVersion), /gh-delta reset/);
});

test('writeSnapshotAtomic round-trips and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'snap.json');
  const data = { pr: { 42: item() }, issue: {}, meta: meta() };
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
  writeSnapshotAtomic(
    '/tmp/snap.json',
    { pr: {}, issue: {}, meta: meta() },
    { fs, uniqueSuffix: () => 'a' },
  );
  writeSnapshotAtomic(
    '/tmp/snap.json',
    { pr: {}, issue: {}, meta: meta() },
    { fs, uniqueSuffix: () => 'b' },
  );
  const writePaths = calls.filter(([kind]) => kind === 'write').map(([, path]) => path);
  assert.deepEqual(writePaths, ['/tmp/snap.json.a.tmp', '/tmp/snap.json.b.tmp']);
});

test('snapshots round-trip the full mandatory schema-v2 meta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'meta.json');
  const data = { pr: {}, issue: {}, meta: meta({ scope: 'watch-pr', entities: ['pr'] }) };
  writeSnapshotAtomic(p, data);
  assert.deepEqual(readSnapshot(p), data);
});

test('snapshots reject an invalid meta.horizon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const p = join(dir, 'meta.json');
  assert.throws(
    () => writeSnapshotAtomic(p, { pr: {}, issue: {}, meta: meta({ horizon: 'not-a-date' }) }),
    /meta\.horizon must be an ISO date string/,
  );
});

test('snapshots reject a meta missing a mandatory field or carrying an unknown one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const { horizon: _horizon, ...missingHorizon } = meta();
  assert.throws(
    () =>
      writeSnapshotAtomic(join(dir, 'missing.json'), { pr: {}, issue: {}, meta: missingHorizon }),
    /meta fields must be exactly/,
  );
  assert.throws(
    () =>
      writeSnapshotAtomic(join(dir, 'extra.json'), {
        pr: {},
        issue: {},
        meta: { ...meta(), extra: true },
      }),
    /meta fields must be exactly/,
  );
});

test('snapshots reject an invalid meta.scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  assert.throws(
    () =>
      writeSnapshotAtomic(join(dir, 'scope.json'), {
        pr: {},
        issue: {},
        meta: meta({ scope: 'bogus' }),
      }),
    /meta\.scope must be one of/,
  );
});

test('snapshots reject an invalid persisted item.meta.changedAt/seenAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const invalidChangedAt = join(dir, 'invalid-changed-at.json');
  writeFileSync(
    invalidChangedAt,
    JSON.stringify({
      pr: { 42: item({ state: 'OPEN' }, {}, { changedAt: 'not-a-date' }) },
      issue: {},
      meta: meta(),
    }),
  );
  assert.throws(() => readSnapshot(invalidChangedAt), /meta\.changedAt must be an ISO date string/);

  const invalidSeenAt = join(dir, 'invalid-seen-at.json');
  writeFileSync(
    invalidSeenAt,
    JSON.stringify({
      pr: { 42: item({ state: 'OPEN' }, {}, { seenAt: 'not-a-date' }) },
      issue: {},
      meta: meta(),
    }),
  );
  assert.throws(() => readSnapshot(invalidSeenAt), /meta\.seenAt must be an ISO date string/);

  const valid = join(dir, 'valid.json');
  const data = {
    pr: { 42: item({ state: 'OPEN' }, {}, { changedAt: '2026-07-01T10:00:00.000Z' }) },
    issue: {},
    meta: meta(),
  };
  writeFileSync(valid, JSON.stringify(data));
  assert.deepEqual(readSnapshot(valid), data);
});

test('horizonCutoff derives from meta.horizon and honors overlap', () => {
  assert.equal(horizonCutoff(null), null);
  assert.equal(
    horizonCutoff({ pr: {}, issue: {}, meta: meta({ horizon: '2026-07-01T12:05:00.000Z' }) }),
    '2026-07-01T12:00:00.000Z', // default 5-minute overlap
  );
});

test('horizonCutoff rejects a missing or invalid meta.horizon (no item-fingerprint fallback)', () => {
  assert.throws(() => horizonCutoff({ pr: {}, issue: {} }), /invalid snapshot horizon/);
  assert.throws(
    () =>
      horizonCutoff({
        pr: { 42: item({ state: 'OPEN', updatedAt: '2026-07-01T10:05:00.000Z' }) },
        issue: {},
      }),
    /invalid snapshot horizon/,
  );
  assert.throws(
    () => horizonCutoff({ pr: {}, issue: {}, meta: meta({ horizon: 'not-a-date' }) }),
    /invalid snapshot horizon/,
  );
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
    { pr: {}, issue: {}, meta: meta() },
    { fs, uniqueSuffix: () => 'a', dirMode: 0o700 },
  );
  writeSnapshotAtomic(
    '/tmp/snap.json',
    { pr: {}, issue: {}, meta: meta() },
    { fs, uniqueSuffix: () => 'b' },
  );
  assert.equal(opts[0].mode, 0o700);
  assert.equal('mode' in opts[1], false);
});

test('writeSnapshotAtomic validates shape before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  assert.throws(
    () => writeSnapshotAtomic(join(dir, 'bad.json'), { pr: [], issue: {}, meta: meta() }),
    /invalid snapshot shape/,
  );
});

test('writeSnapshotAtomic rejects an item missing any of the three sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  for (const missing of ['fingerprint', 'context', 'meta']) {
    const full = item();
    delete full[missing];
    assert.throws(
      () =>
        writeSnapshotAtomic(join(dir, `${missing}.json`), {
          pr: { 42: full },
          issue: {},
          meta: meta(),
        }),
      new RegExp(`pr\\.42\\.${missing} must be an object`),
    );
  }
});

test('writeSnapshotAtomic rejects unknown top-level keys in an item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const withExtra = { ...item(), missing: true };
  assert.throws(
    () =>
      writeSnapshotAtomic(join(dir, 'extra.json'), {
        pr: { 42: withExtra },
        issue: {},
        meta: meta(),
      }),
    /pr\.42 has unknown key\(s\): missing/,
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
      writeSnapshotAtomic(
        '/tmp/snap.json',
        { pr: {}, issue: {}, meta: meta() },
        { fs, uniqueSuffix: () => 'a' },
      ),
    /EXDEV/,
  );
  assert.deepEqual(calls, [
    ['write', '/tmp/snap.json.a.tmp'],
    ['unlink', '/tmp/snap.json.a.tmp'],
  ]);
});
