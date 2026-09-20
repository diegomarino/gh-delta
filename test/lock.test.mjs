// Lock protocol tests. These exercise the acquire/steal/release/fence state
// machine directly against an in-memory fake fs with an injectable `now`, so
// every interleaving below is deterministic -- no real timers, no real
// concurrent processes, and no flakiness from scheduling. Two `runCli` calls
// racing in `Promise.all` would only prove the HAPPY path (natural scheduling
// tends to serialize them); the scenarios that actually matter -- a genuinely
// simultaneous steal, a fence check that fires mid-fetch -- require forcing
// the interleaving by hand, which is exactly what the fake fs below is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  assertLockOwned,
  lockPath,
  LOCK_EXPIRY_SLACK_MS,
  releaseLock,
} from '../lib/lock.mjs';

// ---------------------------------------------------------------------------
// In-memory fake fs. Mirrors exactly the surface lock.mjs uses:
// openSync('wx') is atomic create-exclusive (throws EEXIST if the path
// already "exists"), writeSync/closeSync commit the buffered content,
// readFileSync/statSync/renameSync/unlinkSync throw ENOENT for a missing
// path. This is enough to reproduce every real POSIX semantic the protocol
// depends on without touching disk.
// ---------------------------------------------------------------------------
function enoent() {
  const err = new Error('ENOENT: no such file or directory');
  err.code = 'ENOENT';
  return err;
}
function eexist() {
  const err = new Error('EEXIST: file already exists');
  err.code = 'EEXIST';
  return err;
}

function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fds = new Map();
  let nextFd = 1;
  return {
    files,
    openSync(path, flags) {
      assert.equal(flags, 'wx', 'lock.mjs must only ever open with wx');
      if (files.has(path)) throw eexist();
      // Real O_CREAT|O_EXCL reserves the directory entry at open() time, so a
      // concurrent opener already sees EEXIST before our write/close commits.
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

// A rename "gate": the first caller to rename a given `from` path succeeds,
// every subsequent caller for that same `from` gets ENOENT -- exactly the
// atomicity a real filesystem's rename(2) provides across two processes.
function makeRenameGate() {
  const taken = new Set();
  return (from) => {
    if (taken.has(from)) throw enoent();
    taken.add(from);
  };
}

// Two independent fs "views" (their own file maps, as two OS processes would
// have their own memory) seeded with identical starting content, but sharing
// one rename gate -- the one real point of contention the protocol relies on
// being atomic.
function makeThiefFs(initial, gate) {
  const fs = makeFakeFs(initial);
  const localRename = fs.renameSync.bind(fs);
  fs.renameSync = (from, to) => {
    gate(from);
    return localRename(from, to);
  };
  return fs;
}

const STATE_FILE = '/state/repo__monitor__pr.json';
const LOCK = lockPath(STATE_FILE);
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function expiredRecord(token = 'dead-holder', mtimeMs = 1000) {
  return {
    content: JSON.stringify({
      token,
      pid: 1,
      host: 'h',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:05.000Z', // long expired relative to T0
    }),
    mtimeMs,
  };
}

test('lockPath appends .lock to the state file path', () => {
  assert.equal(lockPath('/a/b/state.json'), '/a/b/state.json.lock');
});

test('LOCK_EXPIRY_SLACK_MS is a small positive constant', () => {
  assert.ok(Number.isFinite(LOCK_EXPIRY_SLACK_MS));
  assert.ok(LOCK_EXPIRY_SLACK_MS > 0);
});

test('clean acquire then release: lock file appears then disappears', () => {
  const fs = makeFakeFs();
  const acquired = acquireLock(STATE_FILE, {
    numberOfFetches: 2,
    ghTimeoutMs: 10_000,
    staleMs: 100_000,
    fs,
    now: () => T0,
  });
  assert.equal(acquired.ok, true);
  assert.equal(typeof acquired.token, 'string');
  assert.ok(fs.files.has(LOCK));
  const record = JSON.parse(fs.readFileSync(LOCK));
  assert.equal(record.token, acquired.token);
  assert.equal(Date.parse(record.acquiredAt), T0);
  assert.equal(Date.parse(record.expiresAt), T0 + 2 * 10_000 + LOCK_EXPIRY_SLACK_MS);

  const released = releaseLock(STATE_FILE, acquired.token, { fs });
  assert.deepEqual(released, { ok: true, released: true });
  assert.equal(fs.files.has(LOCK), false);
});

test('a second acquirer while the first holds a non-expired lock gets busy', () => {
  const fs = makeFakeFs();
  const first = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 60_000,
    staleMs: 100_000,
    fs,
    now: () => T0,
  });
  assert.equal(first.ok, true);

  const second = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 60_000,
    staleMs: 100_000,
    fs,
    now: () => T0 + 1000, // still well inside the first holder's lease
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'held');
  assert.equal(second.holder.token, first.token);

  // The live holder's lock file must be untouched by the failed acquirer.
  const record = JSON.parse(fs.readFileSync(LOCK));
  assert.equal(record.token, first.token);
});

test('a genuinely expired lock is stolen silently and the acquire proceeds', () => {
  const fs = makeFakeFs({ [LOCK]: expiredRecord() });
  const result = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => T0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stolen, true);
  assert.equal(result.warning, undefined); // routine steal, not an anomaly
  const record = JSON.parse(fs.readFileSync(LOCK));
  assert.equal(record.token, result.token);
  assert.notEqual(record.token, 'dead-holder');
});

test('two simultaneous thieves racing the same expired lock: exactly one wins', () => {
  const gate = makeRenameGate();
  const fsA = makeThiefFs({ [LOCK]: expiredRecord() }, gate);
  const fsB = makeThiefFs({ [LOCK]: expiredRecord() }, gate);
  const opts = { numberOfFetches: 1, ghTimeoutMs: 1000, staleMs: 100_000, now: () => T0 };

  const a = acquireLock(STATE_FILE, { ...opts, fs: fsA });
  const b = acquireLock(STATE_FILE, { ...opts, fs: fsB });

  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1, 'exactly one thief must win');
  assert.equal(losers.length, 1, 'exactly one thief must lose');
  assert.equal(losers[0].reason, 'lost-steal-race');
  assert.equal(winners[0].stolen, true);
});

test('a slow-but-alive holder whose lock was stolen fails the fence check', () => {
  const fs = makeFakeFs();
  // The holder acquires while the clock reads far in the past, so its lease
  // has already expired by the time "now" advances to T0 -- modeling a slow
  // fetch that outlasted its own lease.
  const holder = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => Date.parse('2020-01-01T00:00:00.000Z'),
  });
  assert.equal(holder.ok, true);

  const thief = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => T0,
  });
  assert.equal(thief.ok, true);
  assert.equal(thief.stolen, true);
  assert.notEqual(thief.token, holder.token);

  // The pre-write fence: the original (slow) holder must see its ownership
  // gone, while the thief's token still checks out.
  assert.equal(assertLockOwned(STATE_FILE, holder.token, { fs }), false);
  assert.equal(assertLockOwned(STATE_FILE, thief.token, { fs }), true);
});

test('releaseLock refuses to unlink a lock whose token belongs to someone else', () => {
  const fs = makeFakeFs();
  const holder = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => Date.parse('2020-01-01T00:00:00.000Z'),
  });
  const thief = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => T0,
  });
  assert.equal(holder.ok, true);
  assert.equal(thief.ok, true);

  // The stale holder tries to release with its own (now-superseded) token.
  const result = releaseLock(STATE_FILE, holder.token, { fs });
  assert.deepEqual(result, { ok: false, released: false, reason: 'not-owner' });

  // The thief's lock must survive untouched.
  assert.equal(fs.files.has(LOCK), true);
  const record = JSON.parse(fs.readFileSync(LOCK));
  assert.equal(record.token, thief.token);
});

test('releasing a lock that is already gone is a harmless no-op', () => {
  const fs = makeFakeFs();
  const result = releaseLock(STATE_FILE, 'whatever-token', { fs });
  assert.deepEqual(result, { ok: true, released: false });
});

test('an unreadable lock younger than --lock-stale-ms is busy, not stolen', () => {
  const fs = makeFakeFs({
    [LOCK]: { content: '{ not valid json, truncated mid-write', mtimeMs: 1000 },
  });
  const result = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => 1000 + 50_000, // within staleMs of the corrupt file's mtime
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreadable-recent');
  // The corrupt lock must be left exactly as found -- never deleted or replaced.
  assert.equal(fs.readFileSync(LOCK), '{ not valid json, truncated mid-write');
});

test('an unreadable lock older than --lock-stale-ms is stolen, with a warning', () => {
  const fs = makeFakeFs({ [LOCK]: { content: '{ truncated', mtimeMs: 1000 } });
  const result = acquireLock(STATE_FILE, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 100_000,
    fs,
    now: () => 1000 + 200_000, // past staleMs
  });
  assert.equal(result.ok, true);
  assert.equal(result.stolen, true);
  assert.match(result.warning, /unreadable/);
  const record = JSON.parse(fs.readFileSync(LOCK));
  assert.equal(record.token, result.token);
});

test('acquireLock rethrows unexpected fs errors instead of reporting busy', () => {
  const fs = makeFakeFs();
  fs.openSync = () => {
    throw new Error('EPERM: operation not permitted');
  };
  assert.throws(
    () =>
      acquireLock(STATE_FILE, {
        numberOfFetches: 1,
        ghTimeoutMs: 1000,
        staleMs: 100_000,
        fs,
        now: () => T0,
      }),
    /EPERM/,
  );
});

test('acquireLock against the real filesystem round-trips in a temp directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-lock-'));
  const stateFile = join(dir, 'state.json');
  const acquired = acquireLock(stateFile, {
    numberOfFetches: 1,
    ghTimeoutMs: 1000,
    staleMs: 10_000,
  });
  assert.equal(acquired.ok, true);
  assert.equal(assertLockOwned(stateFile, acquired.token), true);
  const busy = acquireLock(stateFile, { numberOfFetches: 1, ghTimeoutMs: 1000, staleMs: 10_000 });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'held');
  const released = releaseLock(stateFile, acquired.token);
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
});
