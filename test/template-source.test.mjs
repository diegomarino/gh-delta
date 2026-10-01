import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTemplateSource } from '../lib/cli/template-source.mjs';
import { runCommand } from '../lib/cli.mjs';
import { applyConfig } from '../lib/config.mjs';

const forbidden = () => assert.fail('invalid template must fail before effects');
const noEffects = {
  env: { GH_DELTA_NO_REGISTRY: '1' },
  resolveRepo: forbidden,
  fetchPRs: forbidden,
  fetchIssues: forbidden,
  acquireLock: forbidden,
  readCursor: forbidden,
  readDeltaLog: forbidden,
  appendDeltaLog: forbidden,
  writeSnapshotAtomic: forbidden,
  registerMonitor: forbidden,
};

test('template source rejects repeated and empty options rather than falling back', () => {
  for (const argv of [
    ['--template', '{id}', '--template={repo}'],
    ['--template-file', 'a', '--template-file=b'],
    ['--template', ''],
    ['--template-file='],
  ]) {
    assert.throws(
      () => selectTemplateSource({ argv, env: { GH_DELTA_TEMPLATE: '{number}' } }),
      /repeated|empty/,
    );
  }
});

test('source group selects CLI then environment then project then user', () => {
  const sources = {
    argv: ['--template={id}'],
    env: { GH_DELTA_TEMPLATE_FILE: 'env' },
    project: { template: '{repo}' },
    user: { 'template-file': 'user' },
  };
  assert.deepEqual(selectTemplateSource(sources), { template: '{id}', layer: 'cli' });
  sources.argv = [];
  assert.deepEqual(selectTemplateSource(sources), { templateFile: 'env', layer: 'env' });
  sources.env = {};
  assert.deepEqual(selectTemplateSource(sources), { template: '{repo}', layer: 'project' });
  sources.project = {};
  assert.deepEqual(selectTemplateSource(sources), { templateFile: 'user', layer: 'user' });
  assert.throws(
    () => selectTemplateSource({ argv: [], project: { template: '', 'template-file': 'x' } }),
    /exclusive|empty/,
  );
});

test('invalid template requests fail before detector and cursor effects', async () => {
  const cases = [
    ['--template', '{summary.typo}'],
    ['--template', ''],
    ['--template', '{id}', '--template={number}'],
    ['--template-file', 'a', '--template-file=b'],
    ['--template', '{id}', '--template-file', 'a'],
    ['--template-sha256', 'a'.repeat(64)],
    ['--template'],
    ['--template-file'],
    ['--template-sha256'],
  ];
  for (const prefix of [
    [],
    ['--repo', 'o/a,o/b'],
    ['read', '--cursor', '/tmp/unused.cursor', '--advance'],
  ]) {
    for (const args of cases) {
      const result = await runCommand([...prefix, '--format=template', ...args], noEffects);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.equal(result.output, '');
      assert.match(result.stderr, /^gh-delta: error /);
    }
  }
});

test('template config keys require strings', () => {
  for (const value of [true, 42]) {
    const result = applyConfig([], {
      env: {},
      cwd: () => '/project',
      homedir: () => '/user',
      readFileSync: (path) =>
        path === '/project/.gh-delta.json' ? JSON.stringify({ template: value }) : '{}',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /string/);
  }
});

test('configured file resolves from invocation cwd and CLI source overrides lower files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-source-'));
  try {
    const project = join(root, 'project');
    const user = join(root, 'user');
    mkdirSync(project);
    mkdirSync(join(user, '.config', 'gh-delta'), { recursive: true });
    writeFileSync(
      join(user, '.config', 'gh-delta', 'config.json'),
      JSON.stringify({ format: 'template', 'template-file': 'line.txt' }),
    );
    writeFileSync(join(project, 'line.txt'), '{summary.typo}');
    const d = { ...noEffects, cwd: () => project, homedir: () => user };
    const result = await runCommand([], d);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /path is unknown/);
    const override = await runCommand(['--template', '{context}'], d);
    assert.match(override.stderr, /path is unknown: context/);
    const read = await runCommand(['read', '--cursor', '/tmp/cursor', '--format', 'template'], d);
    assert.match(read.stderr, /requires --template/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported commands reject template options before effects', async () => {
  for (const command of [
    'wait',
    'status',
    'list',
    'schema',
    'watch',
    'reset',
    'doctor',
    'init',
    'explain',
    'demo',
    'cursor',
  ]) {
    const result = await runCommand([command, '--template', '{id}'], noEffects);
    assert.equal(result.code, 2, command);
    assert.equal(result.stderr, '');
  }
});

test('configured template file rejects stdin and URLs before filesystem lookup', async () => {
  for (const path of ['-', 'https://example.com/template']) {
    const result = await runCommand(['--format', 'template', '--template-file', path], noEffects);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /must be a local file/);
  }
});

test('equal-form inline text may start with two hyphens', async () => {
  const result = await runCommand(
    ['--format', 'template', '--template=--{summary.typo}'],
    noEffects,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /path is unknown/);
});

test('effective detector template config preserves the winning source group and format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-effective-'));
  try {
    const user = join(root, 'user');
    mkdirSync(join(user, '.config', 'gh-delta'), { recursive: true });
    const file = join(root, 'line.txt');
    writeFileSync(file, 'file:{repo}');
    writeFileSync(
      join(user, '.config', 'gh-delta', 'config.json'),
      JSON.stringify({ format: 'template', 'template-file': 'line.txt' }),
    );
    const d = {
      cwd: () => root,
      homedir: () => user,
      env: { GH_DELTA_NO_REGISTRY: '1' },
      readCursor: () => ({ logFile: '/tmp/x', seq: 0 }),
      readDeltaLog: () => ({
        entries: [{ repo: 'o/r', seq: 1, delta: { id: 'x', number: 42 } }],
        scannedTo: 1,
        lastSeq: 1,
        firstSeq: 1,
      }),
      resolveRepo: () => ({ status: 'ok', repo: 'o/r', source: 'test' }),
      fetchPRs: () => ({ rows: [], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      acquireLock: () => ({ ok: true, token: 'x' }),
      assertLockOwned: () => true,
      releaseLock: () => {},
      readSnapshot: () => null,
      writeSnapshotAtomic: () => {},
    };
    const userTick = await runCommand(['--state-file', join(root, 'state')], d);
    assert.equal(userTick.code, 0);
    assert.equal(userTick.output, '');
    assert.equal(userTick.format, 'template');
    writeFileSync(join(root, '.gh-delta.json'), JSON.stringify({ template: 'project:{number}' }));
    const projectTick = await runCommand(['--template', '{summary.typo}'], d);
    assert.equal(projectTick.code, 2);
    assert.match(projectTick.stderr, /path is unknown/);
    const envTick = await runCommand(['--state-file', join(root, 'state')], {
      ...d,
      env: { ...d.env, GH_DELTA_TEMPLATE: '{context}' },
    });
    assert.equal(envTick.code, 2);
    assert.match(envTick.stderr, /path is unknown: context/);
    const noImplicitFormat = await runCommand(['--format', 'json'], d);
    assert.equal(noImplicitFormat.code, 2);
    assert.equal(noImplicitFormat.stderr, '');
    assert.match(noImplicitFormat.output, /requires --format template/);
    const explicitRead = await runCommand(
      ['read', '--cursor', '/tmp/x', '--format', 'template', '--template', 'read:{seq}'],
      d,
    );
    assert.equal(explicitRead.output, 'read:1\n');
    writeFileSync(join(root, '.gh-delta.json'), '{invalid');
    const untrusted = await runCommand([], d);
    assert.equal(untrusted.code, 2);
    assert.equal(untrusted.stderr, '');
    assert.match(untrusted.output, /invalid JSON/);
    const recognized = await runCommand(['--format=template'], d);
    assert.equal(recognized.code, 2);
    assert.equal(recognized.output, '');
    assert.match(recognized.stderr, /^gh-delta: error /);
    for (const args of [['--help'], ['--version'], ['--help-json']])
      assert.equal((await runCommand([...args, '--template'], d)).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal detector and read template files use the nonblocking descriptor path', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'gd-template-cli-fifo-'));
  try {
    for (const prefix of [[], ['read', '--cursor', join(root, 'cursor')]]) {
      const path = join(root, 'line');
      writeFileSync(path, '{id}');
      const script = `
        import { runCommand } from ${JSON.stringify(new URL('../lib/cli.mjs', import.meta.url).href)};
        import { lstatSync, unlinkSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const result = await runCommand(${JSON.stringify([...prefix, '--format', 'template', '--template-file', path])}, {
          env: { GH_DELTA_NO_REGISTRY: '1' },
          lstatSync: (name) => {
            const stat = lstatSync(name); unlinkSync(name); execFileSync('mkfifo', [name]); return stat;
          }
        });
        if (result.code !== 2 || result.output !== '' || !/regular file/.test(result.stderr)) {
          console.error(result); process.exitCode = 1;
        }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        timeout: 1500,
        encoding: 'utf8',
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal CLI oversized templates read only 4099 bytes and never use the config reader', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'gd-template-cli-bound-'));
  try {
    const path = join(root, 'large');
    writeFileSync(path, 'a'.repeat(1024 * 1024));
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalRead = fs.readSync; const originalOpen = fs.openSync;
      let bytes = 0; let templateFd;
      fs.openSync = (name, ...args) => {
        const fd = originalOpen(name, ...args);
        if (name === ${JSON.stringify(path)}) templateFd = fd;
        return fd;
      };
      fs.readSync = (...args) => {
        if (args[0] === templateFd) bytes += args[3];
        return originalRead(...args);
      };
      const originalFileRead = fs.readFileSync;
      fs.readFileSync = (name, ...args) => {
        if (name === ${JSON.stringify(path)}) throw new Error('unbounded template read');
        return originalFileRead(name, ...args);
      };
      syncBuiltinESMExports();
      const { runCommand } = await import(${JSON.stringify(new URL('../lib/cli.mjs', import.meta.url).href)});
      const result = await runCommand(['--format', 'template', '--template-file', ${JSON.stringify(path)}], {
        env: { GH_DELTA_NO_REGISTRY: '1' }
      });
      if (result.code !== 2 || result.output !== '' || !/4098/.test(result.stderr) || bytes !== 4099) {
        console.error({ result, bytes }); process.exitCode = 1;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5000,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
