import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainDelta,
  initializeMonitor,
  runDoctorChecks,
  writeConfigDurableNoOverwrite,
} from '../lib/dx.mjs';

test('init writes durable project config only after a successful baseline and gives the next command', () => {
  let written;
  const result = initializeMonitor(
    { repo: 'o/r', stateDir: '/work/.gh-delta', monitorId: 'main' },
    {
      isTemporaryPath: () => false,
      existsSync: () => false,
      writeFileSync: (_path, contents) => {
        written = JSON.parse(contents);
      },
      tick: () => ({
        code: 0,
        report: { stateFile: '/work/.gh-delta/state.json', baseline: true },
      }),
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(written, { repo: 'o/r', 'state-dir': '/work/.gh-delta', 'monitor-id': 'main' });
  assert.match(result.report.nextCommand, /^gh-delta$/);
});

test('init config write is exclusive and fsynced before close', () => {
  const calls = [];
  writeConfigDurableNoOverwrite(
    '/repo/.gh-delta.json',
    { repo: 'o/r' },
    {
      fs: {
        openSync: (_path, flags, mode) => {
          calls.push(['open', flags, mode]);
          return 7;
        },
        writeSync: (_fd, contents) => {
          calls.push(['write', contents]);
        },
        fsyncSync: (fd) => {
          calls.push(['fsync', fd]);
        },
        closeSync: (fd) => {
          calls.push(['close', fd]);
        },
      },
    },
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ['open', 'write', 'fsync', 'close'],
  );
  assert.equal(calls[0][1], 'wx');
});

test('init does not create config after a failed baseline', () => {
  let wrote = false;
  const result = initializeMonitor(
    { repo: 'o/r', stateDir: '/state', monitorId: 'main', configPath: '/repo/.gh-delta.json' },
    {
      isTemporaryPath: () => false,
      existsSync: () => false,
      writeConfig: () => {
        wrote = true;
      },
      tick: () => ({ code: 1, report: { error: 'offline', hint: 'retry later' } }),
    },
  );
  assert.equal(result.code, 1);
  assert.equal(wrote, false);
});

test('init refuses an existing derived snapshot before invoking its tick', () => {
  let ticked = false;
  const result = initializeMonitor(
    {
      repo: 'o/r',
      stateDir: '/state',
      monitorId: 'main',
      configPath: '/repo/.gh-delta.json',
      stateFile: '/state/o-r.json',
    },
    {
      isTemporaryPath: () => false,
      existsSync: (path) => path === '/state/o-r.json',
      tick: () => {
        ticked = true;
      },
    },
  );
  assert.equal(result.code, 2);
  assert.equal(ticked, false);
});

test('doctor emits one read-only row per check and fails when a required check fails', () => {
  const result = runDoctorChecks(
    { repo: 'o/r', stateDir: '/state', monitorId: 'main' },
    {
      ghInstalled: () => false,
      ghAuthenticated: () => true,
      graphqlRateLimit: () => ({ remaining: 99, resetAt: '2026-01-01T00:00:00Z' }),
      stateDir: () => ({ exists: true, writable: true }),
      nodeVersion: () => 20,
      registryEntries: () => [],
      isTemporaryPath: () => false,
    },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.report.checks.map((row) => row.name),
    [
      'gh-installed',
      'gh-authenticated',
      'org-scope',
      'graphql-rate-limit',
      'state-dir',
      'node',
      'registry',
      'state-dir-tmp',
    ],
  );
});

test('doctor makes a missing organization scope a required failure', () => {
  const result = runDoctorChecks(
    { repo: 'org/r', stateDir: '/state', monitorId: 'main' },
    {
      ghInstalled: () => true,
      ghAuthenticated: () => true,
      orgScope: () => ({ needed: true, ok: false }),
      graphqlRateLimit: () => null,
      stateDir: () => ({ exists: true, writable: true }),
      nodeVersion: () => 20,
      registryEntries: () => [],
      isTemporaryPath: () => false,
    },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.report.checks.find((row) => row.name === 'org-scope'),
    {
      name: 'org-scope',
      ok: false,
      level: 'error',
      detail: 'run gh auth refresh -s read:org',
    },
  );
});

test('doctor reports local and diagnostic failures without throwing', () => {
  const result = runDoctorChecks(
    { repo: 'o/r', stateDir: '/tmp/state', monitorId: 'main', machineId: 'host-a' },
    {
      ghInstalled: () => true,
      ghAuthenticated: () => true,
      graphqlRateLimit: () => {
        throw new Error('quota unavailable');
      },
      stateDir: () => {
        throw new Error('permission denied');
      },
      nodeVersion: () => 17,
      registryEntries: () => {
        throw new Error('registry unavailable');
      },
      isTemporaryPath: () => true,
    },
  );
  assert.equal(result.code, 1);
  const byName = Object.fromEntries(result.report.checks.map((check) => [check.name, check]));
  assert.deepEqual(byName['graphql-rate-limit'].level, 'warning');
  assert.match(byName['graphql-rate-limit'].detail, /quota unavailable/);
  assert.deepEqual(byName['state-dir'].level, 'error');
  assert.match(byName['state-dir'].detail, /permission denied/);
  assert.equal(byName.node.ok, false);
  assert.equal(byName.registry.level, 'warning');
  assert.match(byName.registry.detail, /registry unavailable/);
  assert.equal(byName['state-dir-tmp'].level, 'warning');
});

test('doctor collision scope is the same repo and machine, not merely another monitor', () => {
  const result = runDoctorChecks(
    { repo: 'o/r', stateDir: '/state', monitorId: 'main', machineId: 'host-a' },
    {
      registryEntries: () => [
        { repo: 'o/r', monitorId: 'other', machineId: 'host-a' },
        { repo: 'o/r', monitorId: 'other', machineId: 'host-b' },
        { repo: 'else/r', monitorId: 'other', machineId: 'host-a' },
      ],
      isTemporaryPath: () => false,
    },
  );
  const registry = result.report.checks.find((check) => check.name === 'registry');
  assert.equal(registry.ok, false);
  assert.match(registry.detail, /^1 other monitor/);
});

test('explain uses the persisted delta fingerprints and never needs GitHub', () => {
  // Schema v2: `from`/`to` on a delta are the bare compared fingerprint, not
  // the full snapshot item -- context/meta live only inside the snapshot map,
  // never duplicated under a delta's from/to.
  const delta = {
    id: 'a'.repeat(64),
    from: { state: 'OPEN' },
    to: { state: 'CLOSED' },
  };
  const result = explainDelta(delta.id, [delta]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.changed, { state: { from: 'OPEN', to: 'CLOSED' } });
});

test('explain refuses compact deltas without raw fingerprints', () => {
  const result = explainDelta('b'.repeat(64), [{ id: 'b'.repeat(64), changed: { state: true } }]);
  assert.equal(result.code, 2);
  assert.match(result.error, /raw fingerprints/);
});
