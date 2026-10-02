// CLI contract tests: watch add/rm/ls/sync, labels, and command output.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basePr, item, openFp, RATE_LIMIT, deps } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';
import { addWatch, readWatch, removeWatch, removeWatchUnchanged } from '../lib/watch.mjs';
import { readDeltaLog, setCursorAtomic } from '../lib/deltalog.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';

test('watch add derives only a local repository and defaults monitor/state paths', () => {
  let calls = 0;
  const result = run(['watch', 'add', 'pr:42', '--until', 'merged'], {
    now: () => '2026-07-01T12:00:00Z',
    defaultMonitor: () => 'local',
    resolveLocalRepo: () => {
      calls++;
      return { status: 'found', repo: 'o/r' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.code, 0);
  assert.match(result.report.watchDir, /watch-o%2Fr__local\.d$/);
});

test('watch add --label replaces the map and watch ls text prints sorted tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-label-cli-'));
  const add = run(
    [
      'watch',
      'add',
      'pr:3',
      '--until',
      'merged',
      '--watch-dir',
      dir,
      '--label',
      'thread=t-0004',
      '--label',
      'package=F001-P05',
    ],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(add.code, 0);
  assert.deepEqual(add.report.entry.labels, { package: 'F001-P05', thread: 't-0004' });
  const listed = await runCommand(['watch', 'ls', '--watch-dir', dir, '--format', 'text'], {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  assert.equal(listed.code, 0);
  assert.match(listed.output, /pr:3 until merged package=F001-P05 thread=t-0004/);
  const unlabeled = mkdtempSync(join(tmpdir(), 'gd-watch-label-plain-'));
  run(['watch', 'add', 'pr:3', '--until', 'merged', '--watch-dir', unlabeled], {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  const plain = await runCommand(['watch', 'ls', '--watch-dir', unlabeled, '--format', 'text'], {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  assert.match(plain.output, /pr:3 until merged\n?$/);
  assert.equal(plain.output.includes('package='), false);
  const bad = run(
    ['watch', 'add', 'pr:3', '--until', 'merged', '--watch-dir', dir, '--label', 'thread='],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(bad.code, 2);
  const dup = run(
    [
      'watch',
      'add',
      'pr:3',
      '--until',
      'merged',
      '--watch-dir',
      dir,
      '--label',
      'thread=t-0004',
      '--label',
      'thread=t-0005',
    ],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(dup.code, 2);
  assert.equal(readFileSync(join(dir, 'pr-3.json'), 'utf8').includes('t-0005'), false);
});

test('--label is rejected on watch rm, watch ls, and detector commands before fetch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-label-reject-flag-'));
  for (const argv of [
    ['watch', 'rm', 'pr:3', '--watch-dir', dir, '--label', 'thread=t1'],
    ['watch', 'ls', '--watch-dir', dir, '--label', 'thread=t1'],
  ]) {
    const result = run(argv, { now: () => '2026-09-30T10:00:00.000Z' });
    assert.equal(result.code, 2, argv.join(' '));
  }
  let fetched = false;
  const detected = run(['--repo', 'o/r', '--label', 'thread=t1'], {
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: null };
    },
    fetchIssues: () => ({ rows: [], rateLimit: null }),
  });
  assert.equal(detected.code, 2);
  assert.equal(fetched, false);
});

test('a watch lock failure whose path contains label still exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-labels-lock-'));
  addWatch(dir, 'pr:3', 'merged', { now: () => '2026-09-30T10:00:00.000Z' });
  const path = join(dir, 'pr-3.json');
  const held = acquireLock(path, { ghTimeoutMs: 60000, staleMs: 30000 });
  assert.equal(held.ok, true);
  try {
    const result = run(['watch', 'add', 'pr:3', '--until', 'merged', '--watch-dir', dir], {
      now: () => '2026-09-30T11:00:00.000Z',
    });
    assert.equal(result.code, 1);
    assert.equal(result.report.kind, 'io');
  } finally {
    releaseLock(path, held.token);
  }
});

test('labeled watch entries attach watch.labels without changing delta ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-delta-labels-'));
  addWatch(dir, 'pr:42', 'merged', {
    now: () => '2026-07-01T00:00:00Z',
    labels: { thread: 't-0004', package: 'F001-P05' },
  });
  const argv = ['--repo', 'o/r', '--state-file', join(dir, 'state.json'), '--watch-dir', dir];
  const firstDeps = deps([[]]);
  firstDeps.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  firstDeps.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  const first = run(argv, firstDeps);
  assert.equal(first.code, 0);
  const baseline = JSON.parse(JSON.stringify(firstDeps.stored));
  const changed = { ...basePr, conversationComments: 2, updatedAt: '2026-07-01T11:00:00Z' };
  const secondDeps = deps([[]], { existing: baseline });
  secondDeps.fetchPRsByNumber = () => ({ rows: [changed], rateLimit: RATE_LIMIT });
  secondDeps.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  const second = run([...argv, '--format', 'json'], secondDeps);
  assert.equal(second.code, 10);
  const delta = second.report.deltas[0];
  assert.deepEqual(delta.watch, { labels: { package: 'F001-P05', thread: 't-0004' } });
  const other = mkdtempSync(join(tmpdir(), 'gd-watch-delta-labels-other-'));
  addWatch(other, 'pr:42', 'merged', {
    now: () => '2026-07-01T00:00:00Z',
    labels: { thread: 'other' },
  });
  const relabeledDeps = deps([[]], { existing: baseline });
  relabeledDeps.fetchPRsByNumber = () => ({ rows: [changed], rateLimit: RATE_LIMIT });
  relabeledDeps.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  const relabeled = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      other,
      '--format',
      'json',
    ],
    relabeledDeps,
  );
  assert.equal(relabeled.report.deltas[0].id, delta.id);
  assert.deepEqual(relabeled.report.deltas[0].watch.labels, { thread: 'other' });
});

test('relabeling a watched PR emits no delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-relabel-quiet-'));
  const state = join(dir, 'state.json');
  addWatch(dir, 'pr:42', 'merged', { now: () => '2026-07-01T00:00:00Z' });
  const baselineDeps = deps([[]]);
  baselineDeps.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  baselineDeps.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  run(['--repo', 'o/r', '--state-file', state, '--watch-dir', dir], baselineDeps);
  addWatch(dir, 'pr:42', 'merged', {
    now: () => '2026-07-01T00:00:00Z',
    labels: { thread: 't-0005' },
  });
  const again = deps([[]], { existing: baselineDeps.stored });
  again.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  again.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  const result = run(['--repo', 'o/r', '--state-file', state, '--watch-dir', dir], again);
  assert.equal(result.code, 0);
  assert.equal(result.report.deltas.length, 0);
});

test('watch add local derivation decline is config without GitHub fetches', () => {
  let fetched = false;
  const result = run(['watch', 'add', 'pr:42', '--until', 'merged'], {
    resolveLocalRepo: () => ({ status: 'declined' }),
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(fetched, false);
});

test('watch commands reject wrong positional cardinality before mutation', () => {
  for (const argv of [
    ['watch', 'add', '--until', 'merged', '--watch-dir', '/tmp/nope'],
    ['watch', 'rm', 'pr:1', 'pr:2', '--watch-dir', '/tmp/nope'],
    ['watch', 'ls', 'pr:1', '--watch-dir', '/tmp/nope'],
  ]) {
    const result = run(argv, {
      resolveLocalRepo: () => {
        throw new Error('unused');
      },
    });
    assert.equal(result.code, 2);
    assert.match(result.report.error, /requires exactly/);
  }
});

test('watch text commands render watch-specific output, never detector deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-text-'));
  for (const argv of [
    ['watch', 'add', 'pr:42', '--until', 'merged', '--watch-dir', dir, '--format', 'text'],
    ['watch', 'ls', '--watch-dir', dir, '--format', 'text'],
    ['watch', 'rm', 'pr:42', '--watch-dir', dir, '--format', 'text'],
  ]) {
    const result = await runCommand(argv);
    assert.doesNotMatch(result.output, /delta\(s\)/);
    assert.match(result.output, /watch/);
  }
});

// These cases exercise detector assembly, not just rendering a hand-built delta.
test('watch labels propagate through observation and lifecycle delta classes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-lifecycle-'));
  const watch = join(root, 'watch');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 't1' } });
  const argv = ['--repo', 'o/r', '--state-file', join(root, 'state.json'), '--watch-dir', watch];
  const empty = { pr: {}, issue: {} };
  const cases = [
    ['baseline-state', [basePr], null, ['--baseline-emit-state']],
    ['new', [basePr], empty, []],
    ['first-seen', [{ ...basePr, state: 'closed' }], empty, []],
    ['missing', [], { pr: { 42: item(openFp) }, issue: {} }, []],
    [
      'stale',
      [basePr],
      {
        pr: {
          42: item(openFp, { changedAt: '2026-07-01T00:00:00Z', seenAt: '2026-07-01T00:00:00Z' }),
        },
        issue: {},
      },
      ['--stale-after', '1h'],
    ],
  ];
  for (const [expected, rows, existing, flags] of cases) {
    const d = deps([], { existing });
    d.fetchPRsByNumber = () => ({ rows, rateLimit: RATE_LIMIT });
    const result = run([...argv, ...flags], d);
    assert.equal(result.code, 10, `${expected}: ${JSON.stringify(result.report)}`);
    assert.ok(
      result.report.deltas.some((delta) => delta.classes.includes(expected)),
      expected,
    );
    assert.deepEqual(result.report.deltas[0].watch, { labels: { thread: 't1' } });
  }
  const quiet = deps([]);
  quiet.fetchPRsByNumber = () => ({ rows: [basePr], rateLimit: RATE_LIMIT });
  assert.deepEqual(run(argv, quiet).report.deltas, []);
});

test('watch labels have identical rendered JSON compact and NDJSON maps with detail and full', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-formats-'));
  const watch = join(root, 'watch');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 't1', package: 'p1' } });
  for (const format of ['json', 'compact', 'ndjson']) {
    for (const flags of [[], ['--detail'], ['--full'], ['--detail', '--full']]) {
      const d = deps([], { existing: { pr: { 42: item(openFp) }, issue: {} } });
      d.fetchPRsByNumber = () => ({
        rows: [{ ...basePr, conversationComments: 2 }],
        rateLimit: RATE_LIMIT,
      });
      const result = await runCommand(
        [
          '--repo',
          'o/r',
          '--state-file',
          join(root, 'state.json'),
          '--watch-dir',
          watch,
          '--format',
          format,
          ...flags,
        ],
        d,
      );
      assert.equal(result.code, 10);
      const rendered =
        format === 'ndjson'
          ? result.output
              .trim()
              .split('\n')
              .map(JSON.parse)
              .find((row) => row.type === 'delta')
          : JSON.parse(result.output).deltas[0];
      assert.deepEqual(
        rendered.watch,
        { labels: { package: 'p1', thread: 't1' } },
        `${format} ${flags}`,
      );
    }
  }
});

test('detector accepts one watch version after an update between parsing and capture', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-capture-race-'));
  const watch = join(root, 'watch');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'earlier' } });
  const d = deps([], { existing: { pr: { 42: item(openFp) }, issue: {} } });
  // Repo derivation is the existing seam between readWatch and byte capture.
  d.resolveRepo = () => {
    addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'accepted' } });
    return { status: 'ok', repo: 'o/r', source: 'test' };
  };
  d.fetchPRsByNumber = () => {
    addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'newer' } });
    return { rows: [{ ...basePr, state: 'merged' }], rateLimit: RATE_LIMIT };
  };
  const result = run(['--state-file', join(root, 'state.json'), '--watch-dir', watch], d);
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].watch, { labels: { thread: 'accepted' } });
  assert.equal(JSON.parse(readFileSync(join(watch, 'pr-42.json'), 'utf8')).labels.thread, 'newer');
});

test('an external label replacement immediately before terminal marking aborts without publishing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-mark-race-'));
  const watch = join(root, 'watch');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'earlier' } });
  const d = deps([], { existing: { pr: { 42: item(openFp) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr, state: 'merged' }], rateLimit: RATE_LIMIT });
  d.withTerminalMarkLocks = (_paths, fn) => {
    // Cooperating add/rm now respect the directory lock. An external writer
    // can still replace legacy bytes; the terminal-mark comparison must refuse it.
    const path = join(watch, 'pr-42.json');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...current, labels: { thread: 'newer' } }));
    return fn();
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(root, 'state.json'),
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(result.report.results[0].error.kind, 'busy');
  assert.equal(d.writes, 0);
  const entry = JSON.parse(readFileSync(join(watch, 'pr-42.json'), 'utf8'));
  assert.deepEqual(entry.labels, { thread: 'newer' });
  assert.equal(Object.hasOwn(entry, 'ignoredTerminalAt'), false);
});

test('a relabel during terminal cleanup survives while emitted context stays accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-cleanup-race-'));
  const watch = join(root, 'watch');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'accepted' } });
  const d = deps([], { existing: { pr: { 42: item(openFp) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr, state: 'merged' }], rateLimit: RATE_LIMIT });
  let cleanupRan = false;
  d.removeWatchUnchanged = (path, acceptedBytes) => {
    cleanupRan = true;
    addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'newer' } });
    return removeWatchUnchanged(path, acceptedBytes);
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', join(root, 'state.json'), '--watch-dir', watch],
    d,
  );
  assert.equal(result.code, 10);
  assert.equal(cleanupRan, true);
  assert.deepEqual(result.report.deltas[0].watch, { labels: { thread: 'accepted' } });
  assert.deepEqual(readWatch(watch)[0].labels, { thread: 'newer' });
});

test('durable watch labels replay through log and cursor reads after relabel and removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-label-replay-'));
  const watch = join(root, 'watch');
  const state = join(root, 'state.json');
  addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'historic' } });
  const d = deps([], { existing: { pr: { 42: item(openFp) }, issue: {} } });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, conversationComments: 2 }],
    rateLimit: RATE_LIMIT,
  });
  const produced = run(['--repo', 'o/r', '--state-file', state, '--watch-dir', watch, '--log'], d);
  assert.equal(produced.code, 10);
  const log = produced.report.results[0].logFile;
  const storedDelta = readDeltaLog(log).entries[0].delta;
  assert.deepEqual(storedDelta.watch, { labels: { thread: 'historic' } });
  const cursor = join(root, 'cursor.json');
  setCursorAtomic(cursor, { cursorVersion: 1, logFile: log, seq: 0 });
  for (const removed of [false, true]) {
    if (removed) removeWatch(watch, 'pr:42');
    else addWatch(watch, 'pr:42', 'merged', { labels: { thread: 'today' } });
    assert.deepEqual(readDeltaLog(log).entries[0].delta.watch, storedDelta.watch);
    const replay = await runCommand(['read', '--cursor', cursor, '--format', 'json']);
    assert.equal(replay.code, 10, JSON.stringify(replay.report));
    assert.deepEqual(replay.report.deltas[0].watch, storedDelta.watch);
    assert.deepEqual(JSON.parse(replay.output).deltas[0].watch, storedDelta.watch);
    assert.equal(replay.report.deltas[0].id, storedDelta.id);
  }
});

test('watch sync writes the success report and keeps stdout empty on rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-cli-'));
  const from = join(dir, 'desired.txt');
  writeFileSync(from, 'pr:3 until=merged repo=acme/widgets thread=t-0004\nend 1\n');
  const ok = await runCommand(
    ['watch', 'sync', '--from', from, '--watch-dir', join(dir, 'watch')],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.output), {
    schemaVersion: 2,
    command: 'watch sync',
    added: [{ repo: 'acme/widgets', entity: 'pr', number: 3 }],
    removed: [],
    updated: [],
    unchanged: [],
  });
  writeFileSync(from, 'pr:3 until=merged\n');
  const bad = await runCommand(
    ['watch', 'sync', '--from', from, '--watch-dir', join(dir, 'watch')],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(bad.code, 2);
  assert.equal(bad.output, '');
  assert.match(bad.stderr, /watch sync/);
  const listed = JSON.parse(readFileSync(join(dir, 'watch', 'watch-set.json'), 'utf8'));
  assert.equal(listed.entries.length, 1);
  const empty = await runCommand(
    ['watch', 'sync', '--from', '-', '--watch-dir', join(dir, 'watch')],
    {
      now: () => '2026-09-30T10:00:00.000Z',
      stdin: 'end 0\n',
    },
  );
  assert.equal(empty.code, 2);
  assert.equal(empty.output, '');
});

test('watch sync storage failures exit 1 with a watch sync prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-eacces-'));
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'file');
  const from = join(dir, 'desired.txt');
  writeFileSync(from, 'pr:3 until=merged\nend 1\n');
  const bad = await runCommand(
    ['watch', 'sync', '--from', from, '--watch-dir', join(blocker, 'watch')],
    { now: () => '2026-09-30T10:00:00.000Z' },
  );
  assert.equal(bad.code, 1);
  assert.equal(bad.output, '');
  assert.match(bad.stderr, /watch sync/);
});

test('watch sync missing input exits 1 without changing the watch set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-missing-input-'));
  try {
    const watch = join(dir, 'watch');
    addWatch(watch, 'pr:3', 'merged');
    const before = readWatch(watch);
    const result = await runCommand([
      'watch',
      'sync',
      '--from',
      join(dir, 'missing.txt'),
      '--watch-dir',
      watch,
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.output, '');
    assert.match(result.stderr, /watch sync:.*ENOENT/);
    assert.deepEqual(readWatch(watch), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
