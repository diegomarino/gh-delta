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
