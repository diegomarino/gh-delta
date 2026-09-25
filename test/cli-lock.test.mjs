// CLI <-> lock wiring tests. lib/lock.mjs is exercised directly (against a
// fake fs) in test/lock.test.mjs; this file proves lib/cli.mjs's run()
// actually calls acquireLock before touching GitHub, checks the fence before
// writeSnapshotAtomic, and always releases -- including when the fetch or
// detection step throws.
//
// The real lock.mjs functions (acquireLock/releaseLock/assertLockOwned) are
// used throughout, wired through run()'s `lockFs`/`lockNow` injection seam,
// so this is a genuine integration test of the wiring in lib/cli.mjs -- not a
// re-test of the protocol itself (see test/lock.test.mjs for that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GH_DELTA_NO_REGISTRY = '1';
import { run } from '../lib/cli.mjs';
import { acquireLock, lockPath } from '../lib/lock.mjs';

// Same fake fs shape as test/lock.test.mjs: atomic create-exclusive,
// ENOENT/EEXIST semantics, in-memory only.
function enoent() {
  const err = new Error('ENOENT');
  err.code = 'ENOENT';
  return err;
}
function eexist() {
  const err = new Error('EEXIST');
  err.code = 'EEXIST';
  return err;
}
function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fds = new Map();
  let nextFd = 1;
  return {
    files,
    mkdirSync() {},
    openSync(path, flags) {
      assert.ok(flags === 'wx' || flags === 'w');
      if (flags === 'wx' && files.has(path)) throw eexist();
      files.set(path, { content: '', mtimeMs: 0 });
      const fd = nextFd++;
      fds.set(fd, { path, buf: '' });
      return fd;
    },
    writeSync(fd, data) {
      fds.get(fd).buf += data;
    },
    closeSync(fd) {
      const entry = fds.get(fd);
      files.set(entry.path, { content: entry.buf, mtimeMs: Date.now() });
      fds.delete(fd);
    },
    readFileSync(path) {
      const f = files.get(path);
      if (!f) throw enoent();
      return f.content;
    },
    renameSync(from, to) {
      const f = files.get(from);
      if (!f) throw enoent();
      files.set(to, f);
      files.delete(from);
    },
    linkSync(existingPath, newPath) {
      const f = files.get(existingPath);
      if (!f) throw enoent();
      if (files.has(newPath)) throw eexist();
      files.set(newPath, f);
    },
    unlinkSync(path) {
      if (!files.has(path)) throw enoent();
      files.delete(path);
    },
    statSync(path) {
      const f = files.get(path);
      if (!f) throw enoent();
      return { mtimeMs: f.mtimeMs };
    },
  };
}

const basePr = {
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'sha1',
};

const STATE_FILE = '/state/repo-o%2Fr__monitor-main__pr.json';
const ARGV = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', STATE_FILE];

function snapshotDeps({ existing = null } = {}) {
  let stored = existing;
  let writes = 0;
  return {
    readSnapshot: () => stored,
    writeSnapshotAtomic: (_p, d) => {
      writes++;
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
    get writes() {
      return writes;
    },
    get stored() {
      return stored;
    },
  };
}

test('a busy acquisition exits 1/kind busy and never calls GitHub or writes', () => {
  let fetched = false;
  let wrote = false;
  const result = run(ARGV, {
    ...snapshotDeps(),
    fetchPRs: () => {
      fetched = true;
      return [];
    },
    fetchIssues: () => [],
    writeSnapshotAtomic: () => {
      wrote = true;
    },
    acquireLock: () => ({ ok: false, reason: 'held' }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'busy');
  assert.equal(fetched, false);
  assert.equal(wrote, false);
});

test('stealing an unreadable-but-stale lock surfaces a lock warning on the report', () => {
  const fs = makeFakeFs({ [lockPath(STATE_FILE)]: { content: '{ truncated', mtimeMs: 0 } });
  const d = snapshotDeps({ existing: null });
  const result = run(ARGV, {
    ...d,
    fetchPRs: () => [basePr],
    fetchIssues: () => [],
    lockFs: fs,
    lockNow: () => 10_000_000, // far past mtime 0 + default --lock-stale-ms
  });
  assert.equal(result.code, 0); // baseline
  assert.ok(result.warnings.some((w) => w.label === 'lock' && /unreadable/.test(w.reason)));
});

test('losing the lock mid-fetch fails at the pre-write fence and writes nothing', () => {
  const fs = makeFakeFs();
  const d = snapshotDeps({ existing: null });
  let fenceStolenToken;
  const result = run(ARGV, {
    ...d,
    fetchPRs: () => {
      // Simulate another process's lock timing out and being stolen by a
      // thief WHILE this run is still "fetching". We force the theft by
      // passing a `now` far beyond any possible expiresAt for the steal
      // decision, independent of the run's own lockNow (a valid but distant
      // future Date, since Number.MAX_SAFE_INTEGER overflows Date's range).
      const thief = acquireLock(STATE_FILE, {
        ghTimeoutMs: 1,
        staleMs: 1,
        fs,
        now: () => Date.parse('2099-01-01T00:00:00.000Z'),
      });
      assert.equal(thief.ok, true, 'the thief must successfully steal the expired lock');
      fenceStolenToken = thief.token;
      // The thief writes its own snapshot before this run's fence check runs.
      d.writeSnapshotAtomic(STATE_FILE, { pr: {}, issue: {}, meta: { horizon: 'thief' } });
      return [basePr];
    },
    fetchIssues: () => [],
    lockFs: fs,
    lockNow: () => 0,
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'busy');
  assert.match(result.report.results[0].error.message, /lock lost before snapshot write/);
  // The run must not have overwritten the thief's snapshot.
  assert.equal(d.writes, 1);
  assert.equal(d.stored.meta.horizon, 'thief');
  assert.ok(fenceStolenToken);
});

test('a thrown error mid-run still releases the lock (try/finally)', () => {
  const fs = makeFakeFs();
  const path = lockPath(STATE_FILE);
  const d = snapshotDeps({ existing: null });
  const result = run(ARGV, {
    ...d,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => [],
    lockFs: fs,
    lockNow: () => 0,
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'github');
  // The lock must have been released, not left dangling.
  assert.equal(fs.files.has(path), false);
});

test('a clean run acquires and releases the real lock around the whole tick', () => {
  const fs = makeFakeFs();
  const path = lockPath(STATE_FILE);
  let heldDuringFetch = false;
  const d = snapshotDeps({ existing: null });
  const result = run(ARGV, {
    ...d,
    fetchPRs: () => {
      heldDuringFetch = fs.files.has(path);
      return [basePr];
    },
    fetchIssues: () => [],
    lockFs: fs,
    lockNow: () => 0,
  });
  assert.equal(result.code, 0);
  assert.equal(heldDuringFetch, true, 'the lock must be held while fetching');
  assert.equal(fs.files.has(path), false, 'the lock must be released after a successful run');
});

// P1-1: a first run against a nonexistent explicit --state-dir must succeed
// and seed a baseline. This exercises the whole real stack (real fs, real
// lock.mjs, real writeSnapshotAtomic) end to end, not the fake fs, because
// the bug was specifically that acquireLock's exclusive-create would fail
// with ENOENT against a directory nothing had created yet. Against the old
// code (lock acquired before any mkdir of an explicit --state-dir) this test
// fails with code 1 / kind "io" instead of a baseline.
test('a first run against a nonexistent explicit --state-dir creates it and seeds a baseline (P1-1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cli-lock-statedir-'));
  const stateDir = join(dir, 'nested', 'does-not-exist-yet');
  try {
    const result = run(
      ['--repo', 'o/r', '--monitor-id', 'main', '--state-dir', stateDir, '--entities', 'pr'],
      {
        fetchPRs: () => [basePr],
        fetchIssues: () => [],
        now: () => '2026-07-01T12:00:00Z',
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.report.results[0].baseline, true);
    assert.equal(existsSync(stateDir), true);
    assert.equal(existsSync(result.report.results[0].stateFile), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The shrunk fence window (P1-2's "also" item): writeSnapshotAtomic's
// verifyBeforeCommit runs a SECOND ownership check immediately before its
// final renameSync, narrower than the earlier assertLockOwned call in
// lib/cli.mjs. Simulate ownership being lost strictly between the two checks
// by making the injected assertLockOwned dep answer true the first time
// (the early fence) and false the second (verifyBeforeCommit) -- proving
// both checks actually run and that the late one aborts the write. Against
// code without the verifyBeforeCommit wiring, assertCalls would stop at 1
// and this run would incorrectly succeed and publish the snapshot.
test('ownership lost strictly between the early fence and the snapshot rename still aborts with busy, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cli-lock-fence-'));
  const stateFile = join(dir, 'state.json');
  let assertCalls = 0;
  try {
    const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', stateFile], {
      fetchPRs: () => [basePr],
      fetchIssues: () => [],
      readSnapshot: () => null,
      acquireLock: () => ({ ok: true, token: 'tok' }),
      releaseLock: () => ({ ok: true, released: true }),
      assertLockOwned: () => {
        assertCalls++;
        return assertCalls === 1; // early fence: still owned; verifyBeforeCommit: lost it
      },
      now: () => '2026-07-01T12:00:00Z',
    });
    assert.equal(assertCalls, 2, 'both the early fence and the late verifyBeforeCommit must run');
    assert.equal(result.code, 1);
    assert.equal(result.report.results[0].error.kind, 'busy');
    assert.match(result.report.results[0].error.message, /lock lost before snapshot write/);
    assert.equal(existsSync(stateFile), false, 'nothing must be published once ownership is lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
