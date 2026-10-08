import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  symlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { compileTemplate } from '../lib/template.mjs';

const script = new URL('../skills/gh-delta/scripts/gh-delta-quickstart.sh', import.meta.url)
  .pathname;

function fixture(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gd-quickstart-test-'));
  const bin = join(root, 'bin');
  const checkout = join(root, 'checkout');
  mkdirSync(bin);
  mkdirSync(checkout);
  const trace = join(root, 'trace');
  const command = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const settings = JSON.parse(process.env.QUICKSTART_SETTINGS);
fs.appendFileSync(process.env.QUICKSTART_TRACE, JSON.stringify({ name, args, host: process.env.GH_HOST }) + '\\n');
if (name === 'git') {
  const remote = settings[args[2]] ?? (args[2] === 'origin' ? 'git@github.com:acme/widgets.git' : null);
  if (!remote || settings.noRemote) process.exit(1);
  console.log(remote);
} else if (name === 'gh' && args[0] === 'auth') {
  if (settings.noAuth) { console.error('not logged in'); process.exit(1); }
} else if (name === 'gh' && args[0] === 'repo') {
  if (!settings.resolvedRepo) process.exit(1);
  console.log(JSON.stringify(process.env.GH_REPO ? { nameWithOwner: 'other/repo', url: 'https://github.com/other/repo' } : settings.resolvedRepo));
} else if (name === 'gh' && args[0] === 'api' && settings.actualCli) {
  const stagePath = path.join(process.env.QUICKSTART_ROOT, 'stage');
  const stage = Number(fs.existsSync(stagePath) ? fs.readFileSync(stagePath, 'utf8') : 0);
  if (settings.transient && stage === 1) { console.error('simulated network failure'); process.exit(1); }
  const query = args.find(arg => arg.startsWith('query=')) ?? '';
  const pr = query.includes('pullRequests(');
  const node = {
    number: pr ? 42 : 43, title: pr ? 'Demo PR\\nsafe' : 'Demo issue',
    state: 'OPEN', author: { login: 'alice' },
    url: 'https://github.com/acme/widgets/' + (pr ? 'pull/42' : 'issues/43'),
    updatedAt: new Date(Number(process.env.QUICKSTART_TIME) + (stage > 0 ? 1000 : 0)).toISOString(),
    createdAt: '2026-01-01T00:00:00Z',
    totalCommentsCount: stage > 0 ? 1 : 0,
    comments: { totalCount: stage > 0 ? 1 : 0, nodes: stage > 0 ? [{ id: 'C1', author: { login: 'alice' } }] : [], pageInfo: { hasNextPage: false } },
    headRefName: 'feature/demo', headRefOid: 'abc', isDraft: false,
    mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [] }, latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewThreads: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
    labels: { nodes: [] }, assignees: { nodes: [] },
  };
  if (args.includes('--include')) console.log('HTTP/2.0 200 OK\\nDate: ' + new Date().toUTCString() + '\\n');
  console.log(JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999, resetAt: '2030-01-01T00:00:00Z' }, repository: { items: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
} else if (args.includes('--version')) {
  if (settings.blockVersion) {
    fs.writeFileSync(path.join(process.env.QUICKSTART_ROOT, 'version-child'), String(process.pid));
    setInterval(() => {}, 1000);
  }
  if (settings.noLauncher || (name === 'gh-delta' && settings.extension)) {
    console.error('launcher unavailable'); process.exit(1);
  }
  console.log('gh-delta 0.10.1');
} else if (name === 'sleep') {
  if (settings.actualCli) {
    const stagePath = path.join(process.env.QUICKSTART_ROOT, 'stage');
    const stage = Number(fs.existsSync(stagePath) ? fs.readFileSync(stagePath, 'utf8') : 0) + 1;
    fs.writeFileSync(stagePath, String(stage));
    process.exit(stage >= (settings.transient ? 4 : 3) ? 17 : 0);
  } else if (settings.blockSleep) {
    fs.writeFileSync(path.join(process.env.QUICKSTART_ROOT, 'sleeper'), String(process.pid));
    setInterval(() => {}, 1000);
  } else process.exit(settings.sleepExit ?? 0);
} else {
  const countPath = path.join(process.env.QUICKSTART_ROOT, 'count');
  const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0);
  fs.writeFileSync(countPath, String(count + 1));
  const state = args[args.indexOf('--state-dir') + 1];
  fs.writeFileSync(path.join(state, 'snapshot.json'), 'preserved');
  if (settings.block) {
    fs.writeFileSync(path.join(process.env.QUICKSTART_ROOT, 'child'), String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    const code = (settings.codes ?? [0, 10, 0, 2])[count] ?? 2;
    if (code === 10) console.log(settings.event ?? 'pr #42: Update widget feature/widget [new-comments] https://github.com/acme/widgets/pull/42');
    if (code === 1 || code === 2) console.error('tick error ' + code);
    process.exit(code);
  }
}
`;
  for (const name of ['git', 'gh', 'gh-delta', 'sleep']) {
    writeFileSync(join(bin, name), command, { mode: 0o755 });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GH_DELTA_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    XDG_STATE_HOME: join(root, '.local', 'state'),
    QUICKSTART_ROOT: root,
    QUICKSTART_TRACE: trace,
    QUICKSTART_SETTINGS: JSON.stringify(settings),
    QUICKSTART_TIME: String(Date.now() + 10000),
  });
  const calls = () =>
    existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const ticks = () => calls().filter(({ args }) => args.includes('--state-dir'));
  t.after(() => {
    for (const tick of ticks()) {
      const state = tick.args[tick.args.indexOf('--state-dir') + 1];
      assert.match(state, /^\/tmp\/gh-delta\.[A-Za-z0-9]+$/);
      rmSync(state, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    checkout,
    env,
    calls,
    ticks,
    run: (...args) =>
      spawnSync('/bin/bash', [script, ...args], {
        cwd: checkout,
        env,
        encoding: 'utf8',
        timeout: 10000,
      }),
    start: () =>
      spawn('/bin/bash', [script], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] }),
  };
}

test('quickstart check is read-only and resolves launcher and remote', (t) => {
  const f = fixture(t);
  const result = f.run('--check');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.repo, 'acme/widgets');
  assert.deepEqual(report.launcher, ['gh-delta']);
  assert.equal(f.ticks().length, 0);
  assert.ok(!existsSync(join(f.checkout, '.gh-delta.json')));
});

test('quickstart preserves expected nonzero statuses under bash errexit', (t) => {
  for (const settings of [{ codes: [0, 10, 1, 2] }, { noAuth: true }]) {
    const f = fixture(t, settings);
    const result = spawnSync('/bin/bash', ['-e', script, ...(settings.noAuth ? ['--check'] : [])], {
      cwd: f.checkout,
      env: f.env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, settings.noAuth ? 1 : 2, result.stderr);
    if (settings.noAuth) assert.equal(JSON.parse(result.stdout).ready, false);
    else assert.equal(f.ticks().length, 4);
  }
});

test('bundled scripts work from an installed path containing spaces', (t) => {
  const f = fixture(t, { codes: [2] });
  const installed = join(f.root, 'installed skill with spaces', 'scripts');
  cpSync(new URL('../skills/gh-delta/scripts', import.meta.url), installed, { recursive: true });
  const result = spawnSync('/bin/bash', [join(installed, 'gh-delta-quickstart.sh')], {
    cwd: f.checkout,
    env: f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(f.ticks().length, 1);
  const state = f.ticks()[0].args[f.ticks()[0].args.indexOf('--state-dir') + 1];
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(f.checkout), []);
});

test('quickstart integrates real CLI fetching, snapshots and templates for all scopes', (t) => {
  for (const scope of ['pr', 'issue', 'pr,issue']) {
    const f = fixture(t, { actualCli: true });
    const launcher = join(f.root, 'bin', 'gh-delta');
    rmSync(launcher);
    symlinkSync(new URL('../gh-delta.mjs', import.meta.url).pathname, launcher);
    const result = f.run(scope);
    const state = /state: (\/tmp\/gh-delta\.[A-Za-z0-9]+)/.exec(result.stderr)?.[1];
    if (state) t.after(() => rmSync(state, { recursive: true, force: true }));
    assert.equal(result.status, 17, result.stderr);
    assert.ok(state, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, scope === 'pr,issue' ? 2 : 1, result.stdout);
    if (scope.includes('pr'))
      assert.match(result.stdout, /pr #42: Demo PR\\nsafe feature\/demo \[new-comments\]/);
    if (scope.includes('issue'))
      assert.match(result.stdout, /issue #43: Demo issue {2}\[new-comments\]/);
    assert.deepEqual(readdirSync(f.checkout), []);
    assert.ok(readdirSync(state).some((name) => name.endsWith('.json')));
    assert.ok(!existsSync(join(f.env.XDG_STATE_HOME, 'gh-delta', 'registry')));
  }
});

test('real CLI retries a failed fetch without losing the next delta', (t) => {
  const f = fixture(t, { actualCli: true, transient: true });
  const launcher = join(f.root, 'bin', 'gh-delta');
  rmSync(launcher);
  symlinkSync(new URL('../gh-delta.mjs', import.meta.url).pathname, launcher);
  const result = f.run('pr');
  const state = /state: (\/tmp\/gh-delta\.[A-Za-z0-9]+)/.exec(result.stderr)?.[1];
  if (state) t.after(() => rmSync(state, { recursive: true, force: true }));
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /retrying in 120 seconds/);
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  assert.match(result.stdout, /\[new-comments\]/);
});

test('quickstart readiness failures explain missing prerequisites without ticks', (t) => {
  for (const setting of ['noLauncher', 'noAuth', 'noRemote']) {
    const f = fixture(t, { [setting]: true });
    const result = f.run('--check');
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, false);
    assert.ok(report.reason.length > 0);
    assert.equal(f.ticks().length, 0);
  }
});

test('quickstart reports missing Node without invoking other programs', (t) => {
  const f = fixture(t);
  f.env.PATH = join(f.root, 'bin');
  const result = f.run('--check');
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).reason, /Node.js 22/);
  assert.equal(f.calls().length, 0);
  assert.deepEqual(readdirSync(f.checkout), []);
});

test('quickstart supports the extension and upstream fallback', (t) => {
  const f = fixture(t, {
    extension: true,
    origin: 'https://gitlab.com/acme/widgets.git',
    upstream: 'https://github.com/acme/upstream.git',
  });
  const result = f.run('--check');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.launcher, ['gh', 'delta']);
  assert.equal(report.repo, 'acme/upstream');
});

test('quickstart resolves Enterprise hosts and pins them for ticks', (t) => {
  const f = fixture(t, {
    origin: 'ssh://git@github.example.com/acme/widgets.git',
    resolvedRepo: { nameWithOwner: 'acme/widgets', url: 'https://github.example.com/acme/widgets' },
    codes: [2],
  });
  const check = f.run('--check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).host, 'github.example.com');
  assert.equal(f.run().status, 2);
  assert.equal(f.ticks()[0].host, 'github.example.com');
  assert.ok(
    f
      .calls()
      .some(({ args }) => args.join(' ') === 'auth status --active --hostname github.example.com'),
  );
});

test('checkout fallback ignores GH_REPO overrides', (t) => {
  const f = fixture(t, {
    origin: 'git@enterprise-alias:acme/widgets.git',
    resolvedRepo: { nameWithOwner: 'acme/widgets', url: 'https://github.example.com/acme/widgets' },
  });
  f.env.GH_REPO = 'github.com/other/repo';
  const result = f.run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).repo, 'acme/widgets');
});

test('quickstart cancellation stops preflight descendants too', { timeout: 10000 }, async (t) => {
  const f = fixture(t, { blockVersion: true });
  writeFileSync(
    join(f.root, 'bin', 'mktemp'),
    '#!/bin/bash\ncapture=$(/usr/bin/mktemp "$@") || exit "$?"\nprintf "%s\\n" "$capture" > "$QUICKSTART_ROOT/capture-path"\nprintf "%s\\n" "$capture"\n',
    { mode: 0o755 },
  );
  const child = f.start();
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const stopped = once(child, 'exit');
  const pidFile = join(f.root, 'version-child');
  for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await delay(20);
  assert.ok(existsSync(pidFile), 'preflight launcher started');
  const capture = readFileSync(join(f.root, 'capture-path'), 'utf8').trim();
  assert.match(capture, /^\/tmp\/gh-delta-preflight\.[A-Za-z0-9]+$/);
  assert.equal(statSync(capture).mode & 0o777, 0o600);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  assert.equal((await stopped)[0], 143);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(pid, 0);
      await delay(20);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'preflight descendant exited');
  assert.equal(existsSync(capture), false, 'private preflight capture removed');
  assert.equal(f.ticks().length, 0);
});

test('quickstart rejects invalid scope before probing commands', (t) => {
  const f = fixture(t);
  for (const args of [['prs'], [''], ['pr', 'issue'], ['--check', 'invalid']]) {
    assert.equal(f.run(...args).status, 2);
  }
  assert.equal(f.calls().length, 0);
});

test('quickstart rejects malformed repository slugs before authentication', (t) => {
  for (const origin of [
    'git@github.com:../widgets.git',
    'git@github.com:acme/...git',
    'git@github.com:acme/bad name.git',
  ]) {
    const f = fixture(t, { origin });
    const result = f.run('--check');
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).reason, /invalid repository/);
    assert.ok(!f.calls().some(({ args }) => args[0] === 'auth'));
  }
});

test('quickstart refuses conflicting inherited settings', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.checkout, '.gh-delta.json'),
    JSON.stringify({ 'outpost-url': 'https://example.com/receiver' }),
  );
  const result = f.run('--check');
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).reason, /outpost-url/);
  assert.equal(f.ticks().length, 0);
});

test('quickstart checks user, project, and environment settings with CLI precedence', (t) => {
  const f = fixture(t);
  const userDir = join(f.root, '.config', 'gh-delta');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'config.json'), JSON.stringify({ settled: true }));
  assert.equal(f.run('--check').status, 1);
  writeFileSync(join(f.checkout, '.gh-delta.json'), JSON.stringify({ settled: false }));
  assert.equal(f.run('--check').status, 0);
  f.env.GH_DELTA_SETTLED = 'true';
  assert.equal(f.run('--check').status, 1);
  f.env.GH_DELTA_SETTLED = '0';
  assert.equal(f.run('--check').status, 0);
  f.env.GH_DELTA_SETTLED = 'invalid';
  assert.equal(f.run('--check').status, 1);
  delete f.env.GH_DELTA_SETTLED;
  for (const config of [
    { 'state-file': '/shared/snapshot.json' },
    { 'watch-dir': '/shared/watch' },
    { 'ignore-classes': 'ci-changed' },
    { 'baseline-emit-state': true },
    { repo: 'other/repo' },
    { repo: 42 },
  ]) {
    writeFileSync(join(f.checkout, '.gh-delta.json'), JSON.stringify(config));
    assert.equal(f.run('--check').status, 1, JSON.stringify(config));
  }
  writeFileSync(join(f.checkout, '.gh-delta.json'), 'not JSON private-value');
  const malformed = f.run('--check');
  assert.equal(malformed.status, 1);
  assert.doesNotMatch(malformed.stdout, /private-value/);
  assert.equal(f.ticks().length, 0);
});

test('quickstart rejects old Node before launcher probes', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, 'bin', 'node'),
    `#!${process.execPath}\nObject.defineProperty(process.versions, 'node', { value: '20.0.0' });\nprocess.argv.splice(1, 1);\nimport(require('node:url').pathToFileURL(process.argv[1]).href);\n`,
    { mode: 0o755 },
  );
  const result = f.run('--check');
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).reason, /Node.js 22/);
  assert.equal(f.calls().length, 0);
});

test('quickstart baseline is quiet, changes stream, retries preserve state and cadence', (t) => {
  const f = fixture(t, { codes: [0, 10, 1, 0, 2] });
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /feature\/widget/);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(result.stderr, /Monitoring acme\/widgets/);
  assert.match(result.stderr, /tick error 1/);
  const ticks = f.ticks();
  assert.equal(ticks.length, 5);
  const states = ticks.map(({ args }) => args[args.indexOf('--state-dir') + 1]);
  assert.equal(new Set(states).size, 1);
  assert.equal(readFileSync(join(states[0], 'snapshot.json'), 'utf8'), 'preserved');
  for (const { args, host } of ticks) {
    assert.equal(host, 'github.com');
    assert.equal(args[args.indexOf('--entities') + 1], 'pr,issue');
    assert.ok(args.includes('--no-registry'));
    assert.match(args[args.indexOf('--template') + 1], /\{context.headRefName\}/);
  }
  const template = compileTemplate(ticks[0].args[ticks[0].args.indexOf('--template') + 1]);
  for (const entity of ['pr', 'issue']) {
    const line = template({
      entity,
      number: 42,
      classes: ['new-comments'],
      context: {
        title: 'Widget\nupdate',
        url: 'https://github.com/acme/widgets',
        ...(entity === 'pr' ? { headRefName: 'feature/widget' } : {}),
      },
    });
    assert.equal(
      line,
      `${entity} #42: Widget\\nupdate ${entity === 'pr' ? 'feature/widget' : ''} [new-comments] https://github.com/acme/widgets`,
    );
  }
  assert.deepEqual(
    f
      .calls()
      .filter(({ name }) => name === 'sleep')
      .map(({ args }) => args),
    Array(4).fill(['120']),
  );
});

test('quickstart isolates independent monitors and accepts issue-only scope', (t) => {
  const f = fixture(t, { codes: [2] });
  f.run('issue');
  f.run('pr');
  const ticks = f.ticks();
  assert.equal(ticks.length, 2);
  assert.notEqual(
    ticks[0].args[ticks[0].args.indexOf('--state-dir') + 1],
    ticks[1].args[ticks[1].args.indexOf('--state-dir') + 1],
  );
  assert.equal(ticks[0].args[ticks[0].args.indexOf('--entities') + 1], 'issue');
});

test(
  'quickstart termination stops and reaps its active detector',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t, { block: true });
    const child = f.start();
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const stopped = once(child, 'exit');
    const pidFile = join(f.root, 'child');
    for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await delay(20);
    assert.ok(existsSync(pidFile), 'detector started');
    const detectorPid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    const [code] = await stopped;
    assert.equal(code, 143);
    assert.throws(() => process.kill(detectorPid, 0), /ESRCH/);
  },
);

test('quickstart interruption also stops launcher descendants', { timeout: 10000 }, async (t) => {
  const f = fixture(t, { block: true });
  const launcher = join(f.root, 'bin', 'gh-delta');
  const worker = join(f.root, 'bin', 'worker');
  writeFileSync(worker, readFileSync(launcher), { mode: 0o755 });
  writeFileSync(
    launcher,
    '#!/bin/bash\nif [ "${1:-}" = --version ]; then exit 0; fi\nworker "$@" &\nwait "$!"\n',
    { mode: 0o755 },
  );
  const child = f.start();
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const stopped = once(child, 'exit');
  const pidFile = join(f.root, 'child');
  for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await delay(20);
  assert.ok(existsSync(pidFile), 'launcher descendant started');
  const workerPid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGINT');
  const [code] = await stopped;
  assert.equal(code, 130);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(workerPid, 0);
      await delay(20);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'launcher descendant exited');
});

test(
  'concurrent quickstart processes retain exclusive identities',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t, { block: true });
    const children = [f.start(), f.start()];
    t.after(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    });
    const stopped = children.map((child) => once(child, 'exit'));
    for (let attempt = 0; attempt < 200 && f.ticks().length < 2; attempt++) await delay(20);
    const ticks = f.ticks();
    assert.equal(ticks.length, 2);
    for (const flag of ['--monitor-id', '--state-dir']) {
      assert.notEqual(
        ticks[0].args[ticks[0].args.indexOf(flag) + 1],
        ticks[1].args[ticks[1].args.indexOf(flag) + 1],
      );
    }
    for (const child of children) child.kill('SIGTERM');
    assert.deepEqual(await Promise.all(stopped), [
      [143, null],
      [143, null],
    ]);
  },
);

test(
  'quickstart termination interrupts the two-minute sleep immediately',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t, { blockSleep: true, codes: [0] });
    const child = f.start();
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const stopped = once(child, 'exit');
    const pidFile = join(f.root, 'sleeper');
    for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await delay(20);
    assert.ok(existsSync(pidFile), 'sleep started');
    const sleepPid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    assert.equal((await stopped)[0], 143);
    assert.throws(() => process.kill(sleepPid, 0), /ESRCH/);
    assert.equal(f.ticks().length, 1);
  },
);
