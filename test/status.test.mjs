import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { detectDeltas } from '../lib/detect.mjs';

// Schema v2 item shape: `{ fingerprint, context, meta }`.
const item = (fingerprint = { state: 'open' }, meta = {}) => ({
  fingerprint,
  context: {},
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
    ...meta,
  },
});

test('status reads local snapshot summaries without GitHub or writes', () => {
  const result = run(['status', '--repo', 'o/r', '--state-file', '/tmp/status.json'], {
    readSnapshot: () => ({
      pr: {
        42: item(
          { state: 'open', checks: [] },
          { changedAt: '2026-09-20T00:00:00.000Z', ticksSinceChange: 3 },
        ),
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
      return {
        rows: [
          {
            number: 42,
            title: 'x',
            state: 'open',
            updatedAt: '2026-09-21T00:00:00.000Z',
            isDraft: false,
            checks: [],
            reviewDecision: 'none',
            reviews: [],
            mergeable: 'unknown',
            comments: 0,
            headSha: 'a',
          },
        ],
        rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-21T01:00:00.000Z' },
      };
    },
    fetchIssues: () => ({
      rows: [],
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-21T01:00:00.000Z' },
    }),
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
        pr: { 42: item({ state: 'open', checks: [] }) },
        issue: {},
      };
    },
    fetchPRs: () => assert.fail('status must not fetch GitHub'),
    writeSnapshotAtomic: () => assert.fail('status must not write'),
  });
  assert.equal(result.code, 0);
  assert.match(stateFile, /__watch-pr\.json$/);
  assert.deepEqual(
    result.report.items.map((i) => i.number),
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
        pr: { 42: item({ state: 'open', checks: [] }) },
        issue: {
          7: item(
            { state: 'open' },
            { changedAt: '2026-09-20T00:00:00.000Z', ticksSinceChange: 2 },
          ),
          8: item({ state: 'open' }),
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
          7: item(
            { state: 'open' },
            { changedAt: '2026-09-20T00:00:00.000Z', ticksSinceChange: 2 },
          ),
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

test('status --refresh keeps tracking meta bookkeeping for an unchanged item, without a --stale-after flag', () => {
  // Schema v2: meta.changedAt/ticksSinceChange/staleEmittedFor are tracked on
  // every tick regardless of whether --stale-after is passed this run;
  // --stale-after only gates whether the `stale` delta class fires.
  const current = {
    number: 42,
    title: 'quiet',
    state: 'open',
    updatedAt: '2026-09-18T00:00:00.000Z',
    isDraft: false,
    checks: [],
    reviewDecision: 'none',
    reviews: [],
    mergeable: 'unknown',
    comments: 0,
    headSha: 'abc',
  };
  const snapshot = detectDeltas(
    null,
    { pr: [current], issue: [] },
    { at: '2026-09-18T00:00:00.000Z', staleAfterMs: 1 },
  ).snapshot;
  snapshot.pr[42].meta.ticksSinceChange = 5;
  snapshot.pr[42].meta.staleEmittedFor = '2026-09-19';
  let written;
  const result = run(
    ['status', '--refresh', '--repo', 'o/r', '--state-file', '/tmp/status-refresh.json'],
    {
      acquireLock: () => ({ ok: true, token: 'lock' }),
      assertLockOwned: () => true,
      releaseLock: () => {},
      readSnapshot: () => snapshot,
      writeSnapshotAtomic: (_path, next) => {
        written = next;
      },
      fetchPRs: () => ({
        rows: [current],
        rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-20T01:00:00.000Z' },
      }),
      fetchIssues: () => ({
        rows: [],
        rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-20T01:00:00.000Z' },
      }),
      now: () => '2026-09-20T00:00:00.000Z',
    },
  );
  assert.equal(result.code, 0);
  assert.equal(written.pr[42].meta.changedAt, '2026-09-18T00:00:00.000Z');
  assert.equal(written.pr[42].meta.ticksSinceChange, 6);
  assert.equal(written.pr[42].meta.staleEmittedFor, '2026-09-19');
});

test('status --refresh reuses the repository resolved by the detector', () => {
  let snapshot = null;
  const result = run(['status', '--refresh', '--state-file', '/tmp/status-ghes.json'], {
    acquireLock: () => ({ ok: true, token: 'lock' }),
    assertLockOwned: () => true,
    releaseLock: () => {},
    readSnapshot: () => snapshot,
    writeSnapshotAtomic: (_path, next) => {
      snapshot = next;
    },
    resolveRepo: () => ({
      status: 'found',
      repo: 'enterprise/project',
      source: 'gh',
      warnings: [],
    }),
    resolveLocalRepo: () => assert.fail('status must reuse the detector-resolved repository'),
    fetchPRs: () => ({
      rows: [],
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-20T01:00:00.000Z' },
    }),
    fetchIssues: () => ({
      rows: [],
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-20T01:00:00.000Z' },
    }),
    now: () => '2026-09-20T00:00:00.000Z',
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.repo, 'enterprise/project');
});

test('status validates the effective monitor id before reading its snapshot', () => {
  const result = run(
    ['status', '--repo', 'o/r', '--monitor-id', '../bad', '--state-file', '/tmp/status.json'],
    { readSnapshot: () => assert.fail('invalid monitor id must not read a path') },
  );
  assert.equal(result.code, 2);
  assert.equal(result.report.kind, 'config');
  assert.match(result.report.error, /--monitor-id must start/);
});
