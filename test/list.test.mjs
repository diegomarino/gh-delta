// List tests: the inventory must decode exactly what snapshotPath encoded,
// stay read-only, and report broken snapshots instead of failing on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listMonitors, parseSince, parseSnapshotFilename } from '../lib/list.mjs';
import { registerMonitor } from '../lib/registry.mjs';
import { snapshotPath, writeSnapshotAtomic } from '../lib/snapshot.mjs';

const NOW = '2026-07-08T12:00:00.000Z';

function seed(dir, repo, monitorId, entities, snapshot) {
  const path = snapshotPath(repo, monitorId, entities, dir);
  writeSnapshotAtomic(path, snapshot);
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
    pr: { 1: { state: 'OPEN' }, 2: { state: 'OPEN' } },
    issue: {},
    meta: { horizon: '2026-07-08T11:00:00.000Z' },
  });
  seed(dir, 'o/other', 'all', 'pr,issue', {
    pr: {},
    issue: { 7: { state: 'OPEN' } },
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

test('listMonitors falls back to mtime for legacy snapshots without meta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  const path = seed(dir, 'o/r', 'legacy', 'pr', { pr: {}, issue: {} });
  const mtime = new Date('2026-07-08T10:30:00.000Z');
  utimesSync(path, mtime, mtime);

  const { monitors } = listMonitors(dir, { now: () => NOW });
  assert.equal(monitors[0].lastRun, mtime.toISOString());
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

test('listMonitors identifies self-describing snapshots with arbitrary filenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-list-'));
  writeSnapshotAtomic(join(dir, 'my-private-monitor.json'), {
    pr: { 5: { state: 'OPEN' } },
    issue: {},
    meta: {
      horizon: '2026-07-08T11:00:00.000Z',
      repo: 'o/r',
      monitorId: 'prs-fast',
      entities: ['pr'],
    },
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
    pr: { 1: { state: 'OPEN' } },
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
    issue: { 9: { state: 'OPEN' } },
    meta: { horizon: '2026-07-08T10:00:00.000Z' },
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
