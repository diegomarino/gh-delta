import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWatch, readWatch } from '../lib/watch.mjs';
import { syncWatch } from '../lib/watch-sync.mjs';
import { acquireWatchDirLock, watchDirLockStateFile } from '../lib/watch-lock.mjs';
import { releaseLock } from '../lib/lock.mjs';
import { runCommand } from '../lib/cli.mjs';

for (const action of ['add', 'rm']) {
  test(`legacy watch ${action} cannot bypass a conversion lock in another process`, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'gd-conversion-lock-'));
    try {
      addWatch(dir, 'pr:1', 'merged');
      const lock = acquireWatchDirLock(dir);
      assert.equal(lock.ok, true);
      const args = ['watch', action, action === 'add' ? 'pr:2' : 'pr:1', '--watch-dir', dir];
      if (action === 'add') args.push('--until', 'merged');
      const command = () =>
        spawnSync(
          process.execPath,
          [fileURLToPath(new URL('../gh-delta.mjs', import.meta.url)), ...args],
          { encoding: 'utf8' },
        );
      try {
        const blocked = command();
        assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
        assert.deepEqual(
          readWatch(dir).map((entry) => entry.number),
          [1],
        );
      } finally {
        releaseLock(watchDirLockStateFile(dir), lock.token);
      }
      syncWatch(dir, 'pr:1 until=merged\nend 1\n');
      const retried = command();
      assert.equal(retried.status, 0, retried.stdout + retried.stderr);
      assert.deepEqual(
        readWatch(dir).map((entry) => entry.number),
        action === 'add' ? [1, 2] : [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('manifest filesystem errors remain transient while malformed JSON is permanent', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'gd-manifest-read-error-'));
  const manifest = join(dir, 'watch-set.json');
  try {
    fs.mkdirSync(manifest);
    assert.throws(
      () => readWatch(dir),
      (err) => err.code === 'EISDIR',
    );
    const sync = await runCommand(['watch', 'sync', '--from', '-', '--watch-dir', dir], {
      stdin: 'pr:1 until=merged\nend 1\n',
    });
    assert.equal(sync.code, 1);
    assert.equal(sync.output, '');
    const listed = await runCommand(['watch', 'ls', '--watch-dir', dir]);
    assert.equal(listed.code, 1);
    for (const args of [
      ['--repo', 'o/r'],
      ['--repo', 'o/r,a/b'],
      ['status', '--repo', 'o/r'],
    ]) {
      const failed = await runCommand(
        [...args, '--watch-dir', dir, '--state-dir', join(dir, 'state')],
        {
          env: { GH_DELTA_NO_REGISTRY: '1' },
          fetchPRs: () => assert.fail('storage errors must precede network calls'),
          fetchIssues: () => assert.fail('storage errors must precede network calls'),
        },
      );
      assert.equal(failed.code, 1, args.join(' '));
    }

    fs.rmdirSync(manifest);
    fs.writeFileSync(manifest, '{');
    const invalid = await runCommand(['watch', 'sync', '--from', '-', '--watch-dir', dir], {
      stdin: 'pr:1 until=merged\nend 1\n',
    });
    assert.equal(invalid.code, 2);
    assert.equal(fs.readFileSync(manifest, 'utf8'), '{');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync classifies system errors at input, manifest read, and publication as transient', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'gd-sync-system-error-'));
  const input = join(dir, 'desired.txt');
  const manifest = join(dir, 'watch-set.json');
  const originalRead = fs.readFileSync;
  const originalRename = fs.renameSync;
  try {
    fs.writeFileSync(input, 'pr:2 until=merged\nend 1\n');
    syncWatch(dir, 'pr:1 until=merged\nend 1\n');
    const before = fs.readFileSync(manifest, 'utf8');
    for (const phase of ['input', 'manifest', 'publish']) {
      for (const code of ['EIO', 'EMFILE', 'ENFILE', 'EDQUOT']) {
        const fail = () => {
          throw Object.assign(new Error(`${code}: injected storage failure`), {
            code,
            errno: -5,
            syscall: phase === 'publish' ? 'rename' : 'read',
          });
        };
        fs.readFileSync = (path, ...args) => {
          if (path === (phase === 'input' ? input : phase === 'manifest' ? manifest : null)) fail();
          return originalRead(path, ...args);
        };
        fs.renameSync = (from, to) => {
          if (phase === 'publish' && to === manifest) fail();
          return originalRename(from, to);
        };
        syncBuiltinESMExports();
        const result = await runCommand(['watch', 'sync', '--from', input, '--watch-dir', dir]);
        assert.equal(result.code, 1, `${phase}: ${code}`);
        assert.equal(result.output, '');
        assert.match(result.stderr, new RegExp(code));
        assert.equal(originalRead(manifest, 'utf8'), before);
      }
    }
  } finally {
    fs.readFileSync = originalRead;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
