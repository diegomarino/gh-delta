// CLI contract tests: list subcommand and run-registry breadcrumbs.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePr, deps } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';

test('list subcommand returns a read-only inventory report with code 0', () => {
  const calls = [];
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: (stateDir, options) => {
      calls.push([stateDir, options.sinceMs]);
      return {
        monitors: [
          {
            repo: 'o/r',
            monitorId: 'prs-5m',
            entities: ['pr'],
            stateFile: '/state/repo-o%2Fr__monitor-prs-5m__pr.json',
            lastRun: '2026-07-08T11:00:00.000Z',
            prCount: 2,
            issueCount: 0,
          },
        ],
        skippedFiles: 1,
      };
    },
  };
  const { code, report } = run(['list', '--state-dir', '/state', '--since', '24h'], d);
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.command, 'list');
  assert.equal(report.stateDir, '/state');
  assert.equal(report.since, '24h');
  assert.equal(report.at, '2026-07-08T12:00:00.000Z');
  assert.equal(report.monitors.length, 1);
  assert.equal(report.skippedFiles, 1);
  assert.equal(report.summary, '1 monitor(s)');
  assert.deepEqual(calls, [['/state', 86_400_000]]);
});

test('list rejects an invalid --since as a permanent config error', () => {
  const { code, report } = run(['list', '--since', 'yesterday'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--since/);
});

test('list maps an unreadable state directory to a transient io error', () => {
  const { code, report } = run(['list', '--state-dir', '/state'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(code, 1);
  assert.equal(report.kind, 'io');
  assert.match(report.error, /EACCES/);
});

test('list --help and --help-json describe the subcommand without touching disk', () => {
  const d = {
    listMonitors: () => {
      throw new Error('must not be called');
    },
  };
  const helpText = run(['list', '--help'], d);
  assert.equal(helpText.code, 0);
  assert.match(helpText.report, /gh-delta list \[--state-dir <dir>\]/);
  const helpJson = run(['list', '--help-json'], d);
  assert.equal(helpJson.code, 0);
  const help = JSON.parse(helpJson.report);
  assert.equal(help.command, 'gh-delta list');
  assert.ok(help.options.some((option) => option.name === '--since'));
  assert.equal(
    help.exitCodes.find((entry) => entry.code === 0)?.meaning.includes('Inventory'),
    true,
  );
});

test('main --help advertises the list subcommand', () => {
  const { report } = run(['--help'], {});
  assert.match(report, /Subcommands:/);
  assert.match(report, /\n {2}list\s+Read-only inventory/);
});

test('list --format text renders one line per monitor plus skipped files', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({
      monitors: [
        {
          repo: 'o/r',
          monitorId: 'prs-5m',
          entities: ['pr', 'issue'],
          stateFile: '/state/x.json',
          lastRun: '2026-07-08T11:00:00.000Z',
          prCount: 2,
          issueCount: 3,
        },
        {
          repo: 'o/r',
          monitorId: 'broken',
          entities: ['pr'],
          stateFile: '/state/y.json',
          lastRun: '2026-07-08T10:00:00.000Z',
          prCount: null,
          issueCount: null,
          error: 'invalid snapshot JSON at /state/y.json',
        },
      ],
      skippedFiles: 2,
    }),
  };
  const { code, output } = await runCommand(
    ['list', '--state-dir', '/state', '--format', 'text'],
    d,
  );
  assert.equal(code, 0);
  assert.match(output, /^2026-07-08T12:00:00\.000Z \| 2 monitor\(s\) \| \/state\n/);
  assert.match(
    output,
    /o\/r \| monitor: prs-5m \| entities: pr,issue \| schema: .* \| last run: 2026-07-08T11:00:00\.000Z \| 2 PR\(s\), 3 issue\(s\)/,
  );
  assert.match(output, /o\/r \| monitor: broken \| .* \| snapshot error: invalid snapshot JSON/);
  assert.match(output, /2 unrecognized file\(s\) skipped\./);
});

test('list --format text reports an empty inventory and echoes the window', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({ monitors: [], skippedFiles: 0 }),
  };
  const windowed = await runCommand(
    ['list', '--state-dir', '/state', '--since', '1h', '--format', 'text'],
    d,
  );
  assert.match(windowed.output, /No monitor snapshots ran in the last 1h\./);
  const bare = await runCommand(['list', '--state-dir', '/state', '--format', 'text'], d);
  assert.match(bare.output, /No monitor snapshots found\./);
});

test('list errors in text mode do not borrow snapshot/delta vocabulary', async () => {
  const d = deps([[basePr]]);
  const { output, code } = await runCommand(
    ['list', '--state-dir', '/state', '--since', 'yesterday', '--format', 'text'],
    d,
  );
  assert.equal(code, 2);
  assert.match(output, /gh-delta list error: --since must be/);
  assert.doesNotMatch(output, /delta\(s\)/);
  assert.doesNotMatch(output, /[Ss]napshot was not updated/);
});

test('a successful run leaves an idempotent registry breadcrumb', () => {
  const d = deps([[basePr]]);
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  d.env = {};
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].repo, 'o/r');
  assert.equal(registered[0].monitorId, 'main');
  assert.deepEqual(registered[0].entities, ['pr']);
  assert.equal(registered[0].stateFile, '/tmp/x.json');
  assert.equal(registered[0].lastRun, '2026-07-01T12:00:00Z');
});

test('--no-registry and GH_DELTA_NO_REGISTRY both skip the breadcrumb', () => {
  for (const args of [
    { argv: ['--no-registry'], env: {} },
    { argv: [], env: { GH_DELTA_NO_REGISTRY: '1' } },
  ]) {
    const d = deps([[basePr]]);
    d.registerMonitor = () => {
      throw new Error('must not be called');
    };
    d.env = args.env;
    const { code } = run(
      ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', ...args.argv],
      d,
    );
    assert.equal(code, 0);
  }
});

test('GH_DELTA_NO_REGISTRY only disables the breadcrumb for values that mean "on"', () => {
  // Regression: a plain truthiness test made GH_DELTA_NO_REGISTRY=0 (meaning
  // "registry ON" to a wrapper author) silently skip registration. `0`, `false`,
  // and empty are now treated as unset so the breadcrumb is still written.
  for (const value of ['0', 'false', 'FALSE', '', '  ']) {
    const d = deps([[basePr]]);
    const registered = [];
    d.registerMonitor = (entry) => registered.push(entry);
    d.env = { GH_DELTA_NO_REGISTRY: value };
    const { code } = run(
      ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
      d,
    );
    assert.equal(code, 0);
    assert.equal(
      registered.length,
      1,
      `GH_DELTA_NO_REGISTRY=${JSON.stringify(value)} must still register`,
    );
  }
});

test('a registry write failure never changes the run result', () => {
  const d = deps([[basePr]]);
  d.registerMonitor = () => {
    throw new Error('EACCES: registry dir unwritable');
  };
  d.env = {};
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.results[0].baseline, true);
  assert.equal(d.writes, 1);
});

test('a failed detector attempt updates the registry without changing its result', () => {
  const d = deps([[]]);
  d.env = {};
  d.fetchPRs = () => {
    throw new Error('offline');
  };
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'github');
  assert.deepEqual(
    registered.map(({ status, error }) => [status, error?.kind]),
    [['failure', 'github']],
  );
});

test('a busy detector attempt is recorded as a registry failure', () => {
  const d = deps([[]]);
  d.env = {};
  d.acquireLock = () => ({ ok: false, reason: 'held' });
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'busy');
  assert.deepEqual(
    registered.map(({ status, error }) => [status, error?.kind]),
    [['failure', 'busy']],
  );
});

test('generated monitor identity collision warning is included on success and failure', () => {
  for (const fail of [false, true]) {
    const d = deps([[]]);
    // monitorIdentityWarnings (the mechanism under test) reads via the
    // mocked readRegistry below regardless of GH_DELTA_NO_REGISTRY -- only
    // the WRITE side (registerAttempt) checks that flag, and this test never
    // asserts on a write, so disabling it here just stops a real breadcrumb
    // landing in the developer's ~/.local/state/gh-delta/registry.
    d.env = { GH_DELTA_NO_REGISTRY: '1' };
    d.defaultMonitor = () => 'host-current';
    d.machineId = 'machine-a';
    d.readRegistry = () => ({
      entries: [{ repo: 'o/r', machineId: 'machine-a', monitorId: 'host-other' }],
      skippedFiles: 0,
    });
    if (fail)
      d.fetchPRs = () => {
        throw new Error('offline');
      };
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', '--format', 'text'], d);
    assert.equal(result.code, fail ? 1 : 0);
    assert.ok(result.warnings.some((warning) => warning.label === 'monitor-id'));
  }
});

test('monitor identity collision warning excludes inapplicable and unavailable registry cases', () => {
  // Same reasoning as the test above: monitorIdentityWarnings reads through
  // the mocked readRegistry regardless of GH_DELTA_NO_REGISTRY, so setting it
  // here only stops registerAttempt's WRITE side, which nothing here asserts
  // on, from landing a real breadcrumb in the developer's registry.
  const cases = [
    { argv: ['--format', 'json'], env: { GH_DELTA_NO_REGISTRY: '1' } },
    {
      argv: ['--format', 'text', '--monitor-id', 'host-current'],
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
    {
      argv: ['--format', 'text'],
      env: { GH_DELTA_MONITOR_ID: 'host-current', GH_DELTA_NO_REGISTRY: '1' },
    },
    {
      argv: ['--format', 'text'],
      env: { GH_DELTA_NO_REGISTRY: '1' },
      entry: { repo: 'o/r', machineId: 'machine-a', monitorId: 'host-current' },
    },
    {
      argv: ['--format', 'text'],
      env: { GH_DELTA_NO_REGISTRY: '1' },
      entry: { repo: 'x/y', machineId: 'machine-a', monitorId: 'host-other' },
    },
    {
      argv: ['--format', 'text'],
      env: { GH_DELTA_NO_REGISTRY: '1' },
      entry: { repo: 'o/r', machineId: 'machine-b', monitorId: 'host-other' },
    },
    { argv: ['--format', 'text'], env: { GH_DELTA_NO_REGISTRY: '1' }, registryError: true },
  ];
  for (const { argv, env, entry, registryError } of cases) {
    const d = deps([[]]);
    d.env = env;
    d.defaultMonitor = () => 'host-current';
    d.machineId = 'machine-a';
    d.readRegistry = () => {
      if (registryError) throw new Error('unreadable registry');
      return {
        entries: [entry ?? { repo: 'o/r', machineId: 'machine-a', monitorId: 'host-other' }],
      };
    };
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', ...argv], d);
    assert.equal(
      result.warnings.some((warning) => warning.label === 'monitor-id'),
      false,
    );
  }
});

test('list without --state-dir consults the run registry; --state-dir narrows to a scan', () => {
  const captured = [];
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    env: { GH_DELTA_REGISTRY_DIR: '/reg' },
    listMonitors: (stateDir, options) => {
      captured.push([stateDir, options.registryDir]);
      return { monitors: [], skippedFiles: 0 };
    },
  };
  const global = run(['list'], d);
  assert.equal(global.report.registryDir, '/reg');
  assert.equal(captured[0][1], '/reg');
  const narrowed = run(['list', '--state-dir', '/state'], d);
  assert.equal(narrowed.report.registryDir, null);
  assert.deepEqual(captured[1], ['/state', null]);
});
