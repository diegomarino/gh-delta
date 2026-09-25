import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  listWatch,
  markTerminalIgnored,
  readWatch,
  removeWatch,
  removeWatchUnchanged,
  watchDirPath,
} from '../lib/watch.mjs';
import { ENTRY_LOCK_LEASE_MS, withTerminalMarkLocks } from '../lib/watch-lock.mjs';
import { LOCK_EXPIRY_SLACK_MS } from '../lib/lock.mjs';

// The canonical shape as `addWatch` creates it: {entity, number, until,
// addedAt}. `ignoredTerminalAt` (see markTerminalIgnored below) is an
// OPTIONAL fifth key, never present on a freshly added entry -- it is only
// ever written later, by the detector tick that first observes a filtered
// terminal transition.
const BASE_CANONICAL_KEYS = ['entity', 'number', 'until', 'addedAt'];

test('watch entries are canonical, validated, and atomically manageable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  assert.equal(added.added, true);
  assert.equal(
    readFileSync(join(dir, 'pr-42.json'), 'utf8'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-09-20T12:00:00.000Z"}\n',
  );
  assert.deepEqual(Object.keys(added.entry).sort(), [...BASE_CANONICAL_KEYS].sort());
  assert.deepEqual(listWatch(dir), [added.entry]);
  assert.equal(addWatch(dir, 'pr:42', 'merged', { now: () => 'ignored' }).added, false);
  assert.equal(removeWatch(dir, 'pr:42').removed, true);
  assert.equal(removeWatch(dir, 'pr:42').removed, false);
});

test('markTerminalIgnored extends the canonical shape by exactly one key, atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-mark-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const bytes = readFileSync(added.path, 'utf8');
  assert.equal(markTerminalIgnored(added.path, bytes, '2026-09-20T13:00:00.000Z'), true);
  const [entry] = readWatch(dir);
  assert.deepEqual(Object.keys(entry).sort(), [...BASE_CANONICAL_KEYS, 'ignoredTerminalAt'].sort());
  assert.equal(entry.ignoredTerminalAt, '2026-09-20T13:00:00.000Z');
  assert.equal(
    readFileSync(added.path, 'utf8'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-09-20T12:00:00.000Z","ignoredTerminalAt":"2026-09-20T13:00:00.000Z"}\n',
  );
});

test('markTerminalIgnored is idempotent: a second mark neither rewrites nor changes the timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-mark-idempotent-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const bytes = readFileSync(added.path, 'utf8');
  assert.equal(markTerminalIgnored(added.path, bytes, '2026-09-20T13:00:00.000Z'), true);
  const markedBytes = readFileSync(added.path, 'utf8');
  // The second call passes the ORIGINAL (now-stale) bytes, exactly as a
  // second watched transition in the same tick would -- see
  // lib/cli.mjs's watchTerminalIgnoresToRecord, which can independently
  // rediscover an already-marked entry. It must still succeed (already
  // marked is not a failure) without touching the file again.
  assert.equal(markTerminalIgnored(added.path, bytes, '2026-09-20T14:00:00.000Z'), true);
  assert.equal(readFileSync(added.path, 'utf8'), markedBytes);
});

test('markTerminalIgnored cannot clobber a concurrently replaced entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-mark-race-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const staleBytes = readFileSync(added.path, 'utf8');
  writeFileSync(
    added.path,
    '{"entity":"pr","number":42,"until":"closed","addedAt":"2026-09-20T12:01:00.000Z"}\n',
  );
  assert.equal(markTerminalIgnored(added.path, staleBytes, '2026-09-20T13:00:00.000Z'), false);
  assert.equal(readWatch(dir)[0].until, 'closed');
  assert.equal(Object.hasOwn(readWatch(dir)[0], 'ignoredTerminalAt'), false);
});

test('an entry written before ignoredTerminalAt existed is treated as "never ignored", not rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-pre-upgrade-'));
  // The exact 4-key shape a pre-upgrade gh-delta wrote -- simulated directly
  // (not via addWatch, which always writes the current process's shape) to
  // pin the actual on-disk format an upgrade must tolerate.
  writeFileSync(
    join(dir, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-01-01T00:00:00.000Z"}\n',
  );
  const [entry] = readWatch(dir);
  assert.equal(Object.hasOwn(entry, 'ignoredTerminalAt'), false);
  assert.equal(entry.ignoredTerminalAt, undefined);
});

test('canonical validation still rejects an unknown extra key or a malformed ignoredTerminalAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-invalid-'));
  writeFileSync(
    join(dir, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-01-01T00:00:00.000Z","bogus":true}\n',
  );
  assert.throws(() => readWatch(dir), /invalid watch entry/);
  writeFileSync(
    join(dir, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-01-01T00:00:00.000Z","ignoredTerminalAt":"not-a-date"}\n',
  );
  assert.throws(() => readWatch(dir), /invalid watch entry/);
});

// Round 10: withTerminalMarkLocks's lease must be sized by `leaseMs` alone
// -- a duration meaning "how long may this entry legitimately stay locked"
// -- never by anything resembling a network timeout, since the critical
// section it protects (a mark write, then a full snapshot publish) is pure
// disk I/O. Pin the actual computed expiry directly against the lock file
// on disk, not just against behavior, so a future regression that
// reintroduces a --gh-timeout-ms-flavored value here fails immediately
// rather than only under a slow-filesystem race that is hard to reproduce.
// (An explicit override is used here so the assertion pins an exact number;
// the test below this one covers the no-argument default.)
test('withTerminalMarkLocks sizes the entry lock lease from leaseMs alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-lease-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const before = Date.now();
  let expiresAtMs;
  withTerminalMarkLocks(
    [added.path],
    () => {
      const lock = JSON.parse(readFileSync(`${added.path}.lock`, 'utf8'));
      expiresAtMs = Date.parse(lock.expiresAt);
    },
    { leaseMs: 600000 },
  );
  const impliedLeaseMs = expiresAtMs - before;
  // Must reflect the 600000ms leaseMs (plus the shared slack constant every
  // lock in this codebase adds), not a small network-timeout-sized value --
  // a regression back to `ghTimeoutMs` (commonly tens of seconds) would fail
  // this by roughly an order of magnitude, not by a rounding error.
  assert.ok(
    impliedLeaseMs >= 600000 && impliedLeaseMs <= 600000 + LOCK_EXPIRY_SLACK_MS + 1000,
    `expected the lease to reflect leaseMs (600000ms) + slack, got ${impliedLeaseMs}ms`,
  );
});

// Round 12: the lease must not be derived from --lock-stale-ms either (round
// 11's own regression -- lib/help.mjs and docs/contract.md document that flag
// as governing only an unreadable/corrupt lock, never a readable lock's
// expiresAt). Calling with no options at all -- the shape the one real call
// site (lib/cli.mjs's run()) now uses -- must fall back to the module's own
// fixed ENTRY_LOCK_LEASE_MS constant.
test('withTerminalMarkLocks defaults the entry lock lease to ENTRY_LOCK_LEASE_MS with no override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-lease-default-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const before = Date.now();
  let expiresAtMs;
  withTerminalMarkLocks([added.path], () => {
    const lock = JSON.parse(readFileSync(`${added.path}.lock`, 'utf8'));
    expiresAtMs = Date.parse(lock.expiresAt);
  });
  const impliedLeaseMs = expiresAtMs - before;
  assert.ok(
    impliedLeaseMs >= ENTRY_LOCK_LEASE_MS &&
      impliedLeaseMs <= ENTRY_LOCK_LEASE_MS + LOCK_EXPIRY_SLACK_MS + 1000,
    `expected the default lease to reflect ENTRY_LOCK_LEASE_MS (${ENTRY_LOCK_LEASE_MS}ms) + slack, got ${impliedLeaseMs}ms`,
  );
});

test('watch read rejects corrupt and duplicate canonical entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-'));
  writeFileSync(join(dir, 'pr-42.json'), '{bad');
  assert.throws(() => readWatch(dir), /pr-42\.json/);
  writeFileSync(
    join(dir, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-09-20T12:00:00.000Z"}',
  );
  writeFileSync(
    join(dir, 'extra.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-09-20T12:00:00.000Z"}',
  );
  assert.throws(() => readWatch(dir), /duplicate/);
});

test('watchDirPath keeps watch state monitor-private', () => {
  assert.equal(watchDirPath('o/r', 'main', '/state'), '/state/watch-o%2Fr__main.d');
});

test('terminal cleanup cannot delete a same-entry replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-'));
  const first = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  const oldBytes = readFileSync(first.path, 'utf8');
  writeFileSync(
    first.path,
    '{"entity":"pr","number":42,"until":"closed","addedAt":"2026-09-20T12:01:00.000Z"}\n',
  );
  assert.equal(removeWatchUnchanged(first.path, oldBytes), false);
  assert.equal(readWatch(dir)[0].until, 'closed');
  writeFileSync(`${first.path}.lock`, 'foreign lock artifact');
  assert.deepEqual(
    listWatch(dir).map((entry) => entry.number),
    [42],
  );
});
