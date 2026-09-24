import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfig } from '../lib/config.mjs';
import { runWithOutpost } from '../lib/cli.mjs';

test('config precedence is flag then environment then project then user then defaults', () => {
  const files = new Map([
    ['/repo/.gh-delta.json', JSON.stringify({ format: 'text', 'state-dir': '.project-state' })],
    ['/home/.config/gh-delta/config.json', JSON.stringify({ format: 'compact', entities: 'pr' })],
  ]);
  const readFileSync = (path) => {
    if (!files.has(path)) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return files.get(path);
  };
  const result = applyConfig(['--format', 'ndjson'], {
    cwd: () => '/repo',
    homedir: () => '/home',
    env: { GH_DELTA_FORMAT: 'json', GH_DELTA_ENTITIES: 'issue' },
    readFileSync,
  });

  assert.deepEqual(result, {
    ok: true,
    argv: ['--format', 'ndjson', '--entities', 'issue', '--state-dir', '.project-state'],
    source: '/repo/.gh-delta.json',
  });
});

test('config rejects unknown keys before a command can reach GitHub', () => {
  const result = applyConfig([], {
    cwd: () => '/repo',
    homedir: () => '/home',
    readFileSync: () => '{"not-a-flag": true}',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown key not-a-flag/);
});

test('no project, user, or GH_DELTA values preserves argv byte-for-byte', () => {
  const argv = ['--repo', 'o/r', '--format', 'json'];
  const result = applyConfig(argv, {
    cwd: () => '/repo',
    homedir: () => '/home',
    env: {},
    readFileSync: () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.deepEqual(result, { ok: true, argv, source: null });
});

test('configuration supplies detector outpost settings to the delivery boundary', async () => {
  let delivered = 0;
  const result = await runWithOutpost([], {
    cwd: () => '/repo',
    homedir: () => '/home',
    env: {},
    configReadFileSync: (path) => {
      if (path === '/repo/.gh-delta.json')
        return JSON.stringify({
          repo: 'o/r',
          'state-file': '/state.json',
          'outpost-url': 'https://example.test/hook',
        });
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    acquireLock: () => ({ ok: true, token: 'lock' }),
    releaseLock: () => ({ ok: true }),
    assertLockOwned: () => true,
    readSnapshot: () => ({
      pr: {},
      issue: {},
      meta: {
        schemaVersion: 2,
        ghDeltaVersion: '0.0.0-test',
        repo: 'o/r',
        monitorId: 'main',
        entities: ['pr', 'issue'],
        scope: 'poll',
        horizon: '2025-12-31T00:00:00.000Z',
        createdAt: '2025-12-31T00:00:00.000Z',
        updatedAt: '2025-12-31T00:00:00.000Z',
      },
    }),
    writeSnapshotAtomic: () => {},
    fetchPRs: () => ({
      rows: [
        {
          number: 1,
          title: 'x',
          state: 'OPEN',
          updatedAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          statusCheckRollup: [],
          reviewDecision: 'REVIEW_REQUIRED',
          latestReviews: [],
          mergeable: 'UNKNOWN',
          comments: [],
          headRefOid: 'a',
        },
      ],
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T01:00:00.000Z' },
    }),
    fetchIssues: () => ({
      rows: [],
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T01:00:00.000Z' },
    }),
    now: () => '2026-01-01T00:00:00Z',
    outpostFetch: async () => {
      delivered++;
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.code, 10);
  assert.equal(delivered, 1);
});
