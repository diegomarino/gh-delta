import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  listWatch,
  readWatch,
  removeWatch,
  removeWatchUnchanged,
  watchDirPath,
} from '../lib/watch.mjs';

test('watch entries are canonical, validated, and atomically manageable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-'));
  const added = addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
  assert.equal(added.added, true);
  assert.equal(
    readFileSync(join(dir, 'pr-42.json'), 'utf8'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-09-20T12:00:00.000Z"}\n',
  );
  assert.deepEqual(listWatch(dir), [added.entry]);
  assert.equal(addWatch(dir, 'pr:42', 'merged', { now: () => 'ignored' }).added, false);
  assert.equal(removeWatch(dir, 'pr:42').removed, true);
  assert.equal(removeWatch(dir, 'pr:42').removed, false);
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
