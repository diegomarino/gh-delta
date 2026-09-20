import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';

test('status reads local snapshot summaries without GitHub or writes', () => {
  const result = run(['status', '--repo', 'o/r', '--state-file', '/tmp/status.json'], {
    readSnapshot: () => ({
      pr: {
        42: {
          state: 'OPEN',
          ciChecks: [],
          lastChangedAt: '2026-09-20T00:00:00.000Z',
          ticksSinceChange: 3,
        },
      },
      issue: {},
    }),
    fetchPRs: () => assert.fail('status must not fetch GitHub'),
    writeSnapshotAtomic: () => assert.fail('status must not write'),
    now: () => '2026-09-21T00:00:00.000Z',
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.items[0], {
    entity: 'pr',
    number: 42,
    summary: {
      ciRollup: 'none',
      reviewDecision: 'none',
      mergeable: 'unknown',
      mergeStateStatus: 'unknown',
      state: 'open',
      isDraft: false,
      unresolvedReviewThreads: 0,
      headSha: '',
    },
    lastChangedAt: '2026-09-20T00:00:00.000Z',
    ticksSinceChange: 3,
  });
});

test('status --refresh performs one detector tick before reading the local status', () => {
  let snapshot = null;
  let fetches = 0;
  const deps = {
    acquireLock: () => ({ ok: true, token: 'lock' }),
    assertLockOwned: () => true,
    releaseLock: () => {},
    readSnapshot: () => snapshot,
    writeSnapshotAtomic: (_path, next) => {
      snapshot = next;
    },
    fetchPRs: () => {
      fetches++;
      return [
        {
          number: 42,
          title: 'x',
          state: 'OPEN',
          updatedAt: '2026-09-21T00:00:00.000Z',
          isDraft: false,
          statusCheckRollup: [],
          reviewDecision: null,
          latestReviews: [],
          mergeable: 'UNKNOWN',
          comments: [],
          headRefOid: 'a',
        },
      ];
    },
    fetchIssues: () => [],
    now: () => '2026-09-21T00:00:00.000Z',
  };
  const result = run(
    [
      'status',
      '--refresh',
      '--repo',
      'o/r',
      '--state-file',
      '/tmp/status-refresh.json',
      '--entities',
      'pr',
    ],
    deps,
  );
  assert.equal(result.code, 0);
  assert.equal(fetches, 1);
  assert.equal(result.report.items[0].number, 42);
});

test('status --watch-dir reads the economical PR snapshot without GitHub', () => {
  const watchDir = mkdtempSync(join(tmpdir(), 'gh-delta-status-watch-'));
  writeFileSync(
    join(watchDir, 'repo-o%2Fr__pr-42.json'),
    JSON.stringify({
      entity: 'pr',
      number: 42,
      repo: 'o/r',
      until: 'merged',
      addedAt: '2026-09-20T00:00:00.000Z',
    }),
  );
  let stateFile;
  const result = run(['status', '--repo', 'o/r', '--watch-dir', watchDir], {
    readSnapshot: (path) => {
      stateFile = path;
      return {
        pr: { 42: { state: 'OPEN', ciChecks: [] } },
        issue: {},
      };
    },
    fetchPRs: () => assert.fail('status must not fetch GitHub'),
    writeSnapshotAtomic: () => assert.fail('status must not write'),
  });
  assert.equal(result.code, 0);
  assert.match(stateFile, /__watch-pr\.json$/);
  assert.deepEqual(
    result.report.items.map((item) => item.number),
    [42],
  );
});

test('status includes selected open issues and applies --number to every entity', () => {
  const result = run(
    [
      'status',
      '--repo',
      'o/r',
      '--state-file',
      '/tmp/status-entities.json',
      '--entities',
      'pr,issue',
      '--number',
      '7',
    ],
    {
      readSnapshot: () => ({
        pr: { 42: { state: 'OPEN', ciChecks: [] } },
        issue: {
          7: { state: 'OPEN', lastChangedAt: '2026-09-20T00:00:00.000Z', ticksSinceChange: 2 },
          8: { state: 'OPEN' },
        },
      }),
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.items, [
    {
      entity: 'issue',
      number: 7,
      summary: null,
      lastChangedAt: '2026-09-20T00:00:00.000Z',
      ticksSinceChange: 2,
    },
  ]);
});

test('status text output renders each returned item truthfully', async () => {
  const result = await runCommand(
    ['status', '--repo', 'o/r', '--state-file', '/tmp/status-text.json', '--format', 'text'],
    {
      readSnapshot: () => ({
        pr: {},
        issue: {
          7: { state: 'OPEN', lastChangedAt: '2026-09-20T00:00:00.000Z', ticksSinceChange: 2 },
        },
      }),
    },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /Status o\/r \(1 open item\(s\)\)/);
  assert.match(result.output, /ISSUE #7/);
  assert.match(result.output, /lastChangedAt=2026-09-20T00:00:00.000Z/);
  assert.match(result.output, /ticksSinceChange=2/);
});
