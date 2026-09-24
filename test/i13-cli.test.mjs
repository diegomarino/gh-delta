import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runCommand } from '../lib/cli.mjs';

const lockDeps = {
  acquireLock: () => ({ ok: true, token: 'lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
};
const pr = {
  number: 1,
  title: 'demo',
  state: 'OPEN',
  updatedAt: '2026-01-01T00:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'a',
};

test('init writes project config after baseline and agent mode only prints snippets', () => {
  let config;
  const result = run(
    ['init', '--repo', 'o/r', '--state-dir', '/work/state', '--monitor-id', 'main', '--agent'],
    {
      ...lockDeps,
      now: () => '2026-01-01T00:00:00Z',
      existsSync: () => false,
      writeFileSync: (_path, text) => {
        config = JSON.parse(text);
      },
      isTemporaryPath: () => false,
      readSnapshot: () => null,
      writeSnapshotAtomic: () => {},
      fetchPRs: () => [pr],
      fetchIssues: () => [],
    },
  );
  assert.equal(result.code, 0);
  assert.equal(config.repo, 'o/r');
  assert.equal(result.report.nextCommand, 'gh-delta');
  assert.match(result.report.agent.cron, /'--repo' 'o\/r'/);
  assert.match(result.report.agent.cron, /'--monitor-id' 'main'/);
  assert.match(result.report.agent.cron, /'--entities' 'pr,issue'/);
  assert.match(result.report.agent.cron, /'--state-dir' '\/work\/state'/);
  assert.match(result.report.agent.systemd, /WorkingDirectory=/);
});

test('init returns a hinted standard envelope when durable config creation fails', () => {
  const result = run(['init', '--repo', 'o/r', '--state-dir', '/work/state'], {
    ...lockDeps,
    now: () => '2026-01-01T00:00:00Z',
    existsSync: () => false,
    isTemporaryPath: () => false,
    writeConfig: () => {
      throw new Error('disk full');
    },
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    fetchPRs: () => [pr],
    fetchIssues: () => [],
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'io');
  assert.match(result.report.error, /could not create/);
  assert.equal(typeof result.report.hint, 'string');
});

test('doctor uses injectable read-only gh checks and returns one-line check rows', () => {
  const calls = [];
  const result = run(['doctor', '--repo', 'o/r', '--state-dir', '/work/state'], {
    now: () => '2026-01-01T00:00:00Z',
    defaultMonitor: () => 'main',
    doctorExec: (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'auth')
        return JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'diego' }] } });
      return '';
    },
    fetchRateLimit: () => ({ remaining: 10, resetAt: '2026-01-01T01:00:00Z' }),
    inspectStateDir: () => ({ exists: true, writable: true }),
    nodeVersion: () => 20,
    registryEntries: () => [],
    isTemporaryPath: () => false,
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.checks.length, 8);
  assert.deepEqual(calls[1], [
    'auth',
    'status',
    '--active',
    '--hostname',
    'github.com',
    '--json',
    'hosts',
  ]);
});

test('doctor rejects a successful JSON status without an active authenticated account', () => {
  const result = run(['doctor', '--repo', 'o/r', '--state-dir', '/work/state'], {
    now: () => '2026-01-01T00:00:00Z',
    defaultMonitor: () => 'main',
    doctorExec: (_cmd, args) =>
      args[0] === 'auth'
        ? JSON.stringify({ hosts: { 'github.com': [{ active: false, login: 'diego' }] } })
        : '',
    fetchRateLimit: () => null,
    inspectStateDir: () => ({ exists: true, writable: true }),
    nodeVersion: () => 20,
    registryEntries: () => [],
    isTemporaryPath: () => false,
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.checks.find((check) => check.name === 'gh-authenticated').ok, false);
});

test('init refuses an existing derived monitor snapshot before its baseline tick', () => {
  let fetched = false;
  const result = run(['init', '--repo', 'o/r', '--state-dir', '/work/state'], {
    ...lockDeps,
    now: () => '2026-01-01T00:00:00Z',
    existsSync: (path) => path.endsWith('.json') && !path.endsWith('/.gh-delta.json'),
    isTemporaryPath: () => false,
    fetchPRs: () => {
      fetched = true;
      return [pr];
    },
    fetchIssues: () => [],
  });
  assert.equal(result.code, 2);
  assert.match(result.report.error, /will not consume/);
  assert.equal(fetched, false);
});

test('explain requires explicit local input and demo never contacts the public repo', () => {
  const id = 'a'.repeat(64);
  const explain = run(['explain', id, '--report-file', '/report.json'], {
    now: () => '2026-01-01T00:00:00Z',
    readFileSync: () =>
      JSON.stringify({
        deltas: [
          {
            id,
            classes: ['closed'],
            // Schema v2: `from`/`to` are snapshot items (`{ fingerprint, context, meta }`).
            from: { fingerprint: { state: 'OPEN' }, context: {}, meta: {} },
            to: { fingerprint: { state: 'CLOSED' }, context: {}, meta: {} },
          },
        ],
      }),
  });
  assert.equal(explain.code, 0);
  assert.deepEqual(explain.report.changed, { state: { from: 'OPEN', to: 'CLOSED' } });
  const demo = run(['demo'], { now: () => '2026-01-01T00:00:00Z' });
  assert.equal(demo.code, 0);
  assert.equal(demo.report.repo, 'diegomarino/gh-delta-demo');
});

test('detector config is applied before repository derivation and preserves JSON default', () => {
  let derived = false;
  const result = run([], {
    now: () => '2026-01-01T00:00:00Z',
    env: {},
    cwd: () => '/repo',
    homedir: () => '/home',
    configReadFileSync: () => '{"not-a-flag": true}',
    resolveRepo: () => {
      derived = true;
      return { status: 'found', repo: 'o/r' };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(result.report.kind, 'config');
  assert.equal(derived, false);
});

test('doctor text output retains every check as one truthful row', async () => {
  const result = await runCommand(
    ['doctor', '--repo', 'o/r', '--state-dir', '/work/state', '--format', 'text'],
    {
      now: () => '2026-01-01T00:00:00Z',
      defaultMonitor: () => 'main',
      doctorExec: (_cmd, args) =>
        args[0] === 'auth'
          ? JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'diego' }] } })
          : '',
      fetchRateLimit: () => ({ remaining: 10, resetAt: '2026-01-01T01:00:00Z' }),
      inspectStateDir: () => ({ exists: true, writable: true }),
      nodeVersion: () => 20,
      registryEntries: () => [],
      isTemporaryPath: () => false,
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.output.trim().split('\n').length, 8);
  assert.match(result.output, /^ok \| gh-installed \|/);
});

test('status receives project configuration without contaminating its grammar or contacting GitHub', () => {
  const result = run(['status'], {
    now: () => '2026-01-01T00:00:00Z',
    cwd: () => '/repo',
    homedir: () => '/home',
    env: {},
    configReadFileSync: (path) => {
      if (path === '/repo/.gh-delta.json')
        return JSON.stringify({ repo: 'o/r', 'state-file': '/state.json' });
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    readSnapshot: () => ({ pr: {}, issue: {} }),
    resolveLocalRepo: () => {
      throw new Error('must use config repo');
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.repo, 'o/r');
  assert.equal(result.report.stateFile, '/state.json');
});
