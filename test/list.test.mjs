// List tests: the inventory must decode exactly what snapshotPath encoded,
// stay read-only, and report broken snapshots instead of failing on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listMonitors, parseSince, parseSnapshotFilename } from '../lib/list.mjs';
import { registerMonitor } from '../lib/registry.mjs';
import { snapshotPath, writeSnapshotAtomic } from '../lib/snapshot.mjs';
import { addWatch, watchDirPath } from '../lib/watch.mjs';

const NOW = '2026-07-08T12:00:00.000Z';

// Schema v2 item shape: `{ fingerprint, context, meta }`. list.mjs never reads
// into an item's internals (only Object.keys().length for counts), so a
// minimal valid item is enough for every fixture below.
const item = (fingerprint = { state: 'OPEN' }) => ({
  fingerprint,
  context: {},
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
  },
});

// Schema v2 snapshot-wide meta is mandatory -- see lib/snapshot.mjs's
// validateSnapshotMeta. horizon/createdAt/updatedAt default to NOW so callers
// below only need to override what a given test actually cares about.
function META(overrides = {}) {
  return {
    schemaVersion: 2,
    ghDeltaVersion: '0.0.0-test',
    repo: 'o/r',
    monitorId: 'm',
    entities: ['pr'],
    scope: 'poll',
    horizon: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seed(dir, repo, monitorId, entities, snapshot) {
  const path = snapshotPath(repo, monitorId, entities, dir);
  const { meta: metaOverrides, ...rest } = snapshot;
  writeSnapshotAtomic(path, {
    ...rest,
    meta: META({ repo, monitorId, entities: entities.split(','), ...metaOverrides }),
  });
  return path;
}

test('parseSnapshotFilename round-trips snapshotPath for hostile identifiers', () => {
  const cases = [
    ['a/b-c', 'm', 'pr'],
    ['owner/repo', 'prs_fast.v2', 'pr,issue'],
    ['owner/repo', 'host-0a1b2c3d4e5f', 'issue'],
  ];
  for (const [repo, monitorId, entities] of cases) {
    const decoded = parseSnapshotFilename(basename(snapshotPath(repo, monitorId, entities, '/s')));
    assert.equal(decoded.repo, repo);
    assert.equal(decoded.monitorId, monitorId);
    assert.ok(Array.isArray(decoded.entities));
  }
  const combined = parseSnapshotFilename(basename(snapshotPath('o/r', 'all', 'issue,pr', '/s')));
  assert.deepEqual(combined.entities, ['pr', 'issue']);
});

test('parseSnapshotFilename recognizes economical watch snapshots as a separate scope', () => {
  assert.deepEqual(parseSnapshotFilename('repo-o%2Fr__monitor-main__watch-pr.json'), {
    repo: 'o/r',
    monitorId: 'main',
    entities: ['pr'],
    scope: 'watch-pr',
  });
});

test('parseSnapshotFilename rejects files that are not derived snapshots', () => {
  assert.equal(parseSnapshotFilename('notes.json'), null);
  assert.equal(parseSnapshotFilename('repo-o%2Fr__monitor-m__pr.json.123.tmp'), null);
  assert.equal(parseSnapshotFilename('repo-%ZZ__monitor-m__pr.json'), null);
  assert.equal(parseSnapshotFilename('my-state-file.json'), null);
});

test('parseSince accepts the s/m/h/d grammar and rejects everything else', () => {
  assert.deepEqual(parseSince('90s'), { ms: 90_000 });
  assert.deepEqual(parseSince('15m'), { ms: 900_000 });
  assert.deepEqual(parseSince('24h'), { ms: 86_400_000 });
  assert.deepEqual(parseSince('7d'), { ms: 604_800_000 });
  for (const bad of ['', '24', 'h', '0h', '-1h', '1w', '1.5h', undefined]) {
    assert.match(parseSince(bad).error, /--since/);
  }
});

test('listMonitors inventories derived snapshots, newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  seed(dir, 'o/r', 'prs-5m', 'pr', {
    pr: { 1: item(), 2: item() },
    issue: {},
    meta: { horizon: '2026-07-08T11:00:00.000Z' },
  });
  seed(dir, 'o/other', 'all', 'pr,issue', {
    pr: {},
    issue: { 7: item() },
    meta: { horizon: '2026-07-08T09:00:00.000Z' },
  });
  writeFileSync(join(dir, 'notes.json'), '{}');

  const { monitors, skippedFiles } = listMonitors(dir, { now: () => NOW });
  assert.equal(skippedFiles, 1);
  assert.deepEqual(
    monitors.map((m) => [m.repo, m.monitorId, m.entities, m.lastRun, m.prCount, m.issueCount]),
    [
      ['o/r', 'prs-5m', ['pr'], '2026-07-08T11:00:00.000Z', 2, 0],
      ['o/other', 'all', ['pr', 'issue'], '2026-07-08T09:00:00.000Z', 0, 1],
    ],
  );
  assert.ok(monitors.every((m) => m.stateFile.startsWith(dir)));
  // Read-only: the inventory must not create, rewrite, or remove anything.
  assert.equal(readdirSync(dir).length, 3);
});

test('listMonitors reports a corrupt snapshot as an entry, not a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  const corrupt = snapshotPath('o/r', 'broken', 'pr', dir);
  writeFileSync(corrupt, '{ not json');

  const { monitors } = listMonitors(dir, { now: () => NOW });
  assert.equal(monitors.length, 1);
  assert.match(monitors[0].error, /invalid snapshot JSON/);
  assert.equal(monitors[0].prCount, null);
  assert.equal(monitors[0].issueCount, null);
  assert.ok(monitors[0].lastRun); // mtime fallback keeps the entry sortable
});

test('listMonitors --since window keeps only recent monitors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  seed(dir, 'o/r', 'fresh', 'pr', {
    pr: {},
    issue: {},
    meta: { horizon: '2026-07-08T11:30:00.000Z' },
  });
  seed(dir, 'o/r', 'stale', 'pr', {
    pr: {},
    issue: {},
    meta: { horizon: '2026-07-01T11:30:00.000Z' },
  });

  const { monitors } = listMonitors(dir, { sinceMs: 3_600_000, now: () => NOW });
  assert.deepEqual(
    monitors.map((m) => m.monitorId),
    ['fresh'],
  );
});

test('listMonitors treats a missing directory as an empty inventory', () => {
  assert.deepEqual(listMonitors('/tmp/gd-list-does-not-exist-xyz', { now: () => NOW }), {
    monitors: [],
    skippedFiles: 0,
  });
});

test('listMonitors reports derived watch counts and surfaces corrupt watch state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  seed(dir, 'o/r', 'main', 'pr', { pr: {}, issue: {}, meta: { horizon: NOW } });
  const watchDir = watchDirPath('o/r', 'main', dir);
  addWatch(watchDir, 'pr:42', 'merged', { now: () => NOW });
  assert.equal(listMonitors(dir, { now: () => NOW }).monitors[0].watched, 1);
  writeFileSync(join(watchDir, 'issue-1.json'), '{bad');
  const monitor = listMonitors(dir, { now: () => NOW }).monitors[0];
  assert.equal(monitor.watched, null);
  assert.match(monitor.watchError, /issue-1\.json/);
});

test('listMonitors identifies self-describing snapshots with arbitrary filenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  writeSnapshotAtomic(join(dir, 'my-private-monitor.json'), {
    pr: { 5: item() },
    issue: {},
    meta: META({
      horizon: '2026-07-08T11:00:00.000Z',
      repo: 'o/r',
      monitorId: 'prs-fast',
      entities: ['pr'],
    }),
  });

  const { monitors, skippedFiles } = listMonitors(dir, { now: () => NOW });
  assert.equal(skippedFiles, 0);
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0].repo, 'o/r');
  assert.equal(monitors[0].monitorId, 'prs-fast');
  assert.deepEqual(monitors[0].entities, ['pr']);
  assert.equal(monitors[0].prCount, 1);
});

test('listMonitors merges the registry, dedupes scanned paths, and marks stale entries', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'gd-elsewhere-'));
  const registryDir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  const env = { GH_DELTA_REGISTRY_DIR: registryDir };

  // Monitor A: derived snapshot inside the scanned dir, also registered.
  const scanned = seed(stateDir, 'o/r', 'prs-5m', 'pr', {
    pr: { 1: item() },
    issue: {},
    meta: { horizon: '2026-07-08T11:00:00.000Z' },
  });
  registerMonitor({
    repo: 'o/r',
    monitorId: 'prs-5m',
    entities: ['pr'],
    stateFile: scanned,
    lastRun: '2026-07-08T11:00:00.000Z',
    env,
  });
  // Monitor B: --state-file snapshot outside the scanned dir, known via registry.
  const external = join(elsewhere, 'private.json');
  writeSnapshotAtomic(external, {
    pr: {},
    issue: { 9: item() },
    meta: META({
      horizon: '2026-07-08T10:00:00.000Z',
      repo: 'o/other',
      monitorId: 'issues',
      entities: ['issue'],
    }),
  });
  registerMonitor({
    repo: 'o/other',
    monitorId: 'issues',
    entities: ['issue'],
    stateFile: external,
    lastRun: '2026-07-08T09:59:00.000Z',
    env,
  });
  // Monitor C: registered, but its snapshot no longer exists.
  registerMonitor({
    repo: 'o/gone',
    monitorId: 'retired',
    entities: ['pr'],
    stateFile: join(elsewhere, 'deleted.json'),
    lastRun: '2026-07-08T08:00:00.000Z',
    env,
  });

  const { monitors } = listMonitors(stateDir, { now: () => NOW, registryDir });
  assert.deepEqual(
    monitors.map((m) => [
      m.repo,
      m.monitorId,
      m.lastRun,
      m.prCount,
      m.issueCount,
      m.stale ?? false,
    ]),
    [
      ['o/r', 'prs-5m', '2026-07-08T11:00:00.000Z', 1, 0, false],
      ['o/other', 'issues', '2026-07-08T10:00:00.000Z', 0, 1, false],
      ['o/gone', 'retired', '2026-07-08T08:00:00.000Z', null, null, true],
    ],
  );
});

test('registry-only economical snapshots retain their PR scope and counts', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-state-'));
  const registryDir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'gd-external-'));
  const external = join(externalDir, 'custom.watch.json');
  writeSnapshotAtomic(external, {
    pr: { 42: item() },
    issue: {},
    meta: META({
      horizon: NOW,
      repo: 'o/r',
      monitorId: 'watch',
      entities: ['pr'],
      scope: 'watch-pr',
    }),
  });
  registerMonitor({
    repo: 'o/r',
    monitorId: 'watch',
    entities: ['pr'],
    scope: 'watch-pr',
    stateFile: external,
    lastRun: NOW,
    env: { GH_DELTA_REGISTRY_DIR: registryDir },
  });
  const { monitors } = listMonitors(stateDir, { now: () => NOW, registryDir });
  assert.equal(monitors.length, 1);
  assert.deepEqual(monitors[0].entities, ['pr']);
  assert.equal(monitors[0].scope, 'watch-pr');
  assert.equal(monitors[0].prCount, 1);
});

test('a newer snapshot observation supersedes a stale registry success timestamp', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'gd-elsewhere-'));
  const registryDir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  const env = { GH_DELTA_REGISTRY_DIR: registryDir };
  const external = join(elsewhere, 'private.json');
  writeSnapshotAtomic(external, {
    pr: {},
    issue: {},
    meta: META({
      horizon: '2026-07-08T11:30:00.000Z',
      repo: 'o/r',
      monitorId: 'no-registry-run',
      entities: ['pr'],
    }),
  });
  registerMonitor({
    repo: 'o/r',
    monitorId: 'no-registry-run',
    entities: ['pr'],
    stateFile: external,
    status: 'ok',
    at: '2026-07-08T09:00:00.000Z',
    env,
  });

  const { monitors } = listMonitors(stateDir, {
    registryDir,
    now: () => NOW,
    sinceMs: 60 * 60 * 1000,
  });

  assert.equal(monitors.length, 1);
  assert.equal(monitors[0].lastOkAt, '2026-07-08T11:30:00.000Z');
  assert.equal(monitors[0].observationAgeMs, 30 * 60 * 1000);
});

test('list distinguishes a failed first attempt from a lost successful snapshot and filters by success', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  const registryDir = mkdtempSync(join(tmpdir(), 'gd-reg-'));
  const env = { GH_DELTA_REGISTRY_DIR: registryDir };
  registerMonitor({
    repo: 'o/failed',
    monitorId: 'first',
    entities: ['pr'],
    stateFile: join(stateDir, 'first.json'),
    machineId: 'host-a',
    status: 'failure',
    at: '2026-07-08T11:30:00.000Z',
    error: { kind: 'github', message: 'offline' },
    env,
  });
  registerMonitor({
    repo: 'o/lost',
    monitorId: 'old',
    entities: ['pr'],
    stateFile: join(stateDir, 'old.json'),
    machineId: 'host-a',
    status: 'ok',
    at: '2026-07-08T11:00:00.000Z',
    env,
  });
  const { monitors } = listMonitors(stateDir, {
    registryDir,
    now: () => '2026-07-08T12:00:00.000Z',
    sinceMs: 45 * 60 * 1000,
  });
  assert.equal(monitors.length, 0);
  const all = listMonitors(stateDir, {
    registryDir,
    now: () => '2026-07-08T12:00:00.000Z',
  }).monitors;
  assert.equal(all.find((m) => m.repo === 'o/failed').snapshotStatus, 'not-yet-created');
  assert.equal(all.find((m) => m.repo === 'o/failed').observationAgeMs, null);
  assert.equal(all.find((m) => m.repo === 'o/lost').snapshotStatus, 'expected-missing');
  assert.equal(all.find((m) => m.repo === 'o/lost').stale, true);
});

test('listMonitors reports schemaVersion for a valid snapshot and null for a corrupt one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  seed(dir, 'o/r', 'valid', 'pr', { pr: {}, issue: {} });
  writeFileSync(snapshotPath('o/r', 'broken', 'pr', dir), '{ not json');

  const { monitors } = listMonitors(dir, { now: () => NOW });
  const valid = monitors.find((m) => m.monitorId === 'valid');
  const broken = monitors.find((m) => m.monitorId === 'broken');
  assert.equal(valid.schemaVersion, 2);
  assert.equal(broken.schemaVersion, null);
});
