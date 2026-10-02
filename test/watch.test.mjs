import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { canonicalLabels, captureWatchFiles } from '../lib/watch-entry.mjs';
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

test('canonicalLabels accepts a bounded sorted map and rejects the grammar boundaries', () => {
  const key32 = `k${'a'.repeat(31)}`;
  const key33 = `k${'a'.repeat(32)}`;
  const value128 = `v${'b'.repeat(127)}`;
  const value129 = `v${'b'.repeat(128)}`;
  assert.deepEqual(canonicalLabels({ thread: 't-0004', package: 'F001-P05' }), {
    package: 'F001-P05',
    thread: 't-0004',
  });
  assert.deepEqual(Object.keys(canonicalLabels({ z: 'a1', a: 'b2' })), ['a', 'z']);
  assert.deepEqual(canonicalLabels({}), {});
  assert.deepEqual(canonicalLabels(Object.assign(Object.create(null), { thread: 't1' })), {
    thread: 't1',
  });
  const inherited = Object.create({ hidden: 'nope' });
  inherited.thread = 't1';
  assert.throws(() => canonicalLabels(inherited), /plain object/);
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v0']));
  assert.equal(Object.keys(canonicalLabels(eight)).length, 8);
  function labeled(key, value) {
    const map = Object.create(null);
    map[key] = value;
    return map;
  }
  for (const input of [
    null,
    [],
    new Date(),
    { ...eight, k9: 'v0' },
    { [key33]: 'v0' },
    { k: value129 },
    { until: 'merged' },
    { repo: 'o/r' },
    { '1bad': 'v0' },
    { k: '' },
    { k: ' has-space' },
    { '': 'v0' },
  ]) {
    assert.throws(() => canonicalLabels(input), /label/i);
  }
  assert.throws(() => canonicalLabels(labeled('__proto__', 'x')), /label/i);
  assert.throws(() => canonicalLabels(labeled('constructor', 'x')), /label/i);
  assert.throws(() => canonicalLabels(labeled('prototype', 'x')), /label/i);
  assert.deepEqual(canonicalLabels({ [key32]: value128 }), { [key32]: value128 });
  const hiddenValid = {};
  Object.defineProperty(hiddenValid, 'thread', {
    value: 't1',
    enumerable: false,
    configurable: true,
  });
  assert.deepEqual(canonicalLabels(hiddenValid), { thread: 't1' });
  const hiddenReserved = { thread: 't1' };
  Object.defineProperty(hiddenReserved, 'until', {
    value: 'merged',
    enumerable: false,
    configurable: true,
  });
  assert.throws(() => canonicalLabels(hiddenReserved), /label/i);
  const withSymbol = { thread: 't1' };
  Object.defineProperty(withSymbol, Symbol('meta'), { value: 'x' });
  assert.throws(() => canonicalLabels(withSymbol), /label/i);
  const nineWithHidden = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v0']));
  Object.defineProperty(nineWithHidden, 'until', {
    value: 'merged',
    enumerable: false,
    configurable: true,
  });
  assert.throws(() => canonicalLabels(nineWithHidden), /at most 8 labels/);
});

const NOW = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T11:00:00.000Z';

function bytes(dir, name) {
  return readFileSync(join(dir, name), 'utf8');
}

test('addWatch creates, replaces, preserves, and clears labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-'));
  const created = addWatch(dir, 'pr:3', 'merged', {
    now: () => NOW,
    labels: { thread: 't-0004', package: 'F001-P05' },
  });
  assert.equal(created.added, true);
  assert.equal(
    bytes(dir, 'pr-3.json'),
    '{"entity":"pr","number":3,"until":"merged","addedAt":"2026-09-30T10:00:00.000Z","labels":{"package":"F001-P05","thread":"t-0004"}}\n',
  );
  const unchanged = bytes(dir, 'pr-3.json');
  const same = addWatch(dir, 'pr:3', 'merged', {
    now: () => LATER,
    labels: { package: 'F001-P05', thread: 't-0004' },
  });
  assert.equal(same.added, false);
  assert.equal(bytes(dir, 'pr-3.json'), unchanged);
  const omitted = addWatch(dir, 'pr:3', 'merged', { now: () => LATER });
  assert.equal(omitted.added, false);
  assert.deepEqual(omitted.entry.labels, { package: 'F001-P05', thread: 't-0004' });
  const replaced = addWatch(dir, 'pr:3', 'merged', {
    now: () => LATER,
    labels: { thread: 't-0005' },
  });
  assert.equal(replaced.added, true);
  assert.equal(replaced.entry.addedAt, NOW);
  assert.deepEqual(replaced.entry.labels, { thread: 't-0005' });
  const marked = readFileSync(replaced.path, 'utf8');
  assert.equal(markTerminalIgnored(replaced.path, marked, '2026-09-30T12:00:00.000Z'), true);
  const relabeled = addWatch(dir, 'pr:3', 'merged', {
    now: () => LATER,
    labels: { thread: 't-0006' },
  });
  assert.equal(relabeled.entry.addedAt, NOW);
  assert.equal(relabeled.entry.ignoredTerminalAt, '2026-09-30T12:00:00.000Z');
  assert.deepEqual(relabeled.entry.labels, { thread: 't-0006' });
  const cleared = addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: {} });
  assert.equal(cleared.added, true);
  assert.equal(Object.hasOwn(cleared.entry, 'labels'), false);
  assert.equal(cleared.entry.ignoredTerminalAt, '2026-09-30T12:00:00.000Z');
  const untilReset = addWatch(dir, 'pr:3', 'closed', { now: () => LATER });
  assert.equal(untilReset.added, true);
  assert.equal(untilReset.entry.addedAt, LATER);
  assert.equal(Object.hasOwn(untilReset.entry, 'ignoredTerminalAt'), false);
  assert.equal(Object.hasOwn(untilReset.entry, 'labels'), false);
});

test('changing until carries existing labels unless an explicit map is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-until-'));
  addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: { thread: 't-0004' } });
  const carried = addWatch(dir, 'pr:3', 'closed', { now: () => LATER });
  assert.equal(carried.entry.addedAt, LATER);
  assert.deepEqual(carried.entry.labels, { thread: 't-0004' });
  const explicit = addWatch(dir, 'pr:3', 'merged', {
    now: () => '2026-09-30T12:00:00.000Z',
    labels: { package: 'F001-P05' },
  });
  assert.deepEqual(explicit.entry.labels, { package: 'F001-P05' });
  assert.equal(Object.hasOwn(explicit.entry, 'ignoredTerminalAt'), false);
});

test('non-enumerable reserved own labels are rejected before any watch write', () => {
  const poisoned = { thread: 't1' };
  Object.defineProperty(poisoned, 'until', {
    value: 'merged',
    enumerable: false,
    configurable: true,
  });
  const missing = join(tmpdir(), `gd-watch-labels-hidden-${process.pid}-${Date.now()}`);
  assert.throws(
    () => addWatch(missing, 'pr:3', 'merged', { now: () => NOW, labels: poisoned }),
    /label/i,
  );
  assert.equal(existsSync(missing), false);

  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-hidden-existing-'));
  addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: { thread: 't-0004' } });
  const before = bytes(dir, 'pr-3.json');
  assert.throws(
    () => addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: poisoned }),
    /label/i,
  );
  assert.equal(bytes(dir, 'pr-3.json'), before);

  const symbolic = { thread: 't1' };
  Object.defineProperty(symbolic, Symbol('meta'), { value: 'x' });
  assert.throws(
    () => addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: symbolic }),
    /label/i,
  );
  assert.equal(bytes(dir, 'pr-3.json'), before);
});

test('addWatch persists a valid non-enumerable label as a canonical enumerable map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-hidden-valid-'));
  const hidden = {};
  Object.defineProperty(hidden, 'thread', {
    value: 't1',
    enumerable: false,
    configurable: true,
  });
  const created = addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: hidden });
  assert.equal(created.added, true);
  assert.deepEqual(created.entry.labels, { thread: 't1' });
  assert.deepEqual(Object.keys(created.entry.labels), ['thread']);
  assert.equal(
    bytes(dir, 'pr-3.json'),
    '{"entity":"pr","number":3,"until":"merged","addedAt":"2026-09-30T10:00:00.000Z","labels":{"thread":"t1"}}\n',
  );
});

test('invalid labels and malformed label-bearing entries do not change bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-reject-'));
  addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: { thread: 't-0004' } });
  const before = bytes(dir, 'pr-3.json');
  assert.throws(
    () => addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: { until: 'merged' } }),
    /label/i,
  );
  assert.equal(bytes(dir, 'pr-3.json'), before);
  writeFileSync(join(dir, 'pr-3.json'), '{"entity":"pr","number":3,"labels":[]}\n');
  const broken = bytes(dir, 'pr-3.json');
  assert.throws(() => addWatch(dir, 'pr:3', 'merged', { now: () => LATER }), /invalid watch entry/);
  assert.throws(
    () => addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: { thread: 't-0005' } }),
    /invalid watch entry/,
  );
  assert.equal(bytes(dir, 'pr-3.json'), broken);
  writeFileSync(join(dir, 'pr-9.json'), '{"entity":"pr","number":9,"extra":true}\n');
  const legacy = bytes(dir, 'pr-9.json');
  const replaced = addWatch(dir, 'pr:9', 'merged', { now: () => NOW });
  assert.equal(replaced.added, true);
  assert.notEqual(bytes(dir, 'pr-9.json'), legacy);
  writeFileSync(join(dir, 'pr-8.json'), '{"entity":"pr","number":8,"extra":true}\n');
  const legacyLabeled = bytes(dir, 'pr-8.json');
  assert.throws(
    () => addWatch(dir, 'pr:8', 'merged', { now: () => NOW, labels: { thread: 't1' } }),
    /invalid watch entry/,
  );
  assert.equal(bytes(dir, 'pr-8.json'), legacyLabeled);
});

test('readWatch rejects an empty stored label map and lists canonical labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-read-'));
  addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: { thread: 't-0004' } });
  assert.deepEqual(listWatch(dir)[0].labels, { thread: 't-0004' });
  writeFileSync(
    join(dir, 'pr-3.json'),
    '{"entity":"pr","number":3,"until":"merged","addedAt":"2026-09-30T10:00:00.000Z","labels":{}}\n',
  );
  assert.throws(() => readWatch(dir), /invalid watch entry/);
});

test('captureWatchFiles pairs labels with the bytes of one read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-capture-'));
  const added = addWatch(dir, 'pr:3', 'merged', {
    now: () => NOW,
    labels: { thread: 't-0004' },
  });
  const [captured] = captureWatchFiles(dir, readWatch(dir));
  assert.equal(captured.path, added.path);
  assert.equal(captured.bytes, readFileSync(added.path, 'utf8'));
  assert.deepEqual(captured.entry.labels, { thread: 't-0004' });
  assert.equal(`${JSON.stringify(captured.entry)}\n`, captured.bytes);
});

test('removeWatchUnchanged leaves a newer labeled entry in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-labels-cleanup-'));
  const added = addWatch(dir, 'pr:3', 'merged', { now: () => NOW, labels: { thread: 't-0004' } });
  const stale = bytes(dir, 'pr-3.json');
  addWatch(dir, 'pr:3', 'merged', { now: () => LATER, labels: { thread: 't-0005' } });
  assert.equal(removeWatchUnchanged(added.path, stale), false);
  assert.deepEqual(readWatch(dir)[0].labels, { thread: 't-0005' });
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

test('addWatch rejects non-plain label maps before creating or changing state', () => {
  class Labels {
    thread = 't1';
  }
  const root = mkdtempSync(join(tmpdir(), 'gd-watch-prototypes-'));
  for (const labels of [
    new Labels(),
    Object.assign(Object.create({ hidden: 'x' }), { thread: 't1' }),
  ]) {
    const absent = join(root, 'absent');
    assert.throws(() => addWatch(absent, 'pr:3', 'merged', { labels }), /plain object/);
    assert.equal(existsSync(absent), false);
    const existing = addWatch(root, 'pr:3', 'merged', { labels: { thread: 'old' } });
    const before = readFileSync(existing.path, 'utf8');
    assert.throws(() => addWatch(root, 'pr:3', 'merged', { labels }), /plain object/);
    assert.equal(readFileSync(existing.path, 'utf8'), before);
  }
});

test('published watch exports retain the existing API surface', async () => {
  assert.deepEqual(
    Object.keys(await import('gh-delta/watch')).sort(),
    [
      'addWatch',
      'listWatch',
      'markTerminalIgnored',
      'parseWatchItem',
      'readWatch',
      'removeWatch',
      'removeWatchUnchanged',
      'watchDirPath',
      'watchFilename',
    ].sort(),
  );
});

test('ordinary label maps ignore inherited Object.prototype entries', () => {
  Object.defineProperty(Object.prototype, 'inheritedLabel', {
    value: 'ignored',
    enumerable: true,
    configurable: true,
  });
  try {
    assert.deepEqual(canonicalLabels({ thread: 't1' }), { thread: 't1' });
  } finally {
    delete Object.prototype.inheritedLabel;
  }
});
