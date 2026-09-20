import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWatch, readWatch } from '../lib/watch.mjs';
import { buildOutpostPayload } from '../lib/outpost.mjs';

const locks = {
  acquireLock: () => ({ ok: true, token: 'test-lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
};

function pr(number, title) {
  return {
    number,
    title,
    state: 'OPEN',
    updatedAt: '2026-09-20T10:00:00Z',
    isDraft: false,
    statusCheckRollup: [],
    reviewDecision: 'REVIEW_REQUIRED',
    latestReviews: [],
    mergeable: 'UNKNOWN',
    comments: [],
    headRefOid: `sha-${number}`,
  };
}

test('multi-repo aggregates successful ticks in requested order and qualifies each delta', () => {
  const snapshots = new Map();
  const result = run(
    [
      '--repo',
      'A/ONE,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/i9-multi',
      '--entities',
      'pr',
    ],
    {
      ...locks,
      now: () => '2026-09-20T12:00:00.000Z',
      readSnapshot: (path) => snapshots.get(path) ?? { pr: {}, issue: {} },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => (repo === 'a/one' ? [pr(1, 'one')] : [pr(2, 'two')]),
      fetchIssues: () => [],
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );

  assert.equal(result.code, 10);
  assert.deepEqual(result.report.repos, ['a/one', 'b/two']);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.repo),
    ['a/one', 'b/two'],
  );
  assert.deepEqual(result.report.errors, []);
  assert.equal(result.report.summary, '2 delta(s) across 2 repo(s); 0 error(s)');
  assert.equal(snapshots.size, 2);
});

test('multi-repo rejects one state file before attempting a repository tick', () => {
  let fetched = 0;
  const result = run(['--repo', 'a/one,b/two', '--state-file', '/tmp/one.json'], {
    fetchPRs: () => {
      fetched++;
      return [];
    },
    now: () => '2026-09-20T12:00:00.000Z',
  });
  assert.equal(result.code, 2);
  assert.match(result.report.error, /--state-file/);
  assert.equal(fetched, 0);
});

test('a failed repository does not prevent a later repository from publishing its delta', () => {
  const snapshots = new Map();
  const result = run(
    [
      '--repo',
      'a/one,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/i9-partial',
      '--entities',
      'pr',
    ],
    {
      ...locks,
      now: () => '2026-09-20T12:00:00.000Z',
      readSnapshot: (path) => snapshots.get(path) ?? { pr: {}, issue: {} },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => {
        if (repo === 'a/one') throw new Error('temporary GitHub failure');
        return [pr(2, 'two')];
      },
      fetchIssues: () => [],
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.repo),
    ['b/two'],
  );
  assert.deepEqual(result.report.errors, [
    { repo: 'a/one', kind: 'github', message: 'temporary GitHub failure' },
  ]);
  assert.equal(snapshots.size, 1);
});

test('repo-scoped watch entries keep equal item numbers independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-i9-watch-'));
  try {
    addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z', repo: 'a/one' });
    addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z', repo: 'b/two' });
    assert.deepEqual(
      readWatch(dir).map((entry) => entry.repo),
      ['a/one', 'b/two'],
    );
    assert.deepEqual(
      readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort(),
      ['repo-a%2Fone__pr-42.json', 'repo-b%2Ftwo__pr-42.json'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate outposts use the delta repository for identity and links', () => {
  const payload = buildOutpostPayload({
    report: { monitorId: 'i9', at: '2026-09-20T12:00:00.000Z' },
    delta: {
      id: 'f'.repeat(64),
      repo: 'b/two',
      entity: 'pr',
      number: 2,
      title: 'two',
      classes: ['new'],
      to: { state: 'OPEN' },
    },
  });
  assert.equal(payload.repo, 'b/two');
  assert.match(payload.eventId, /:b\/two:/);
  assert.equal(payload.links.html, 'https://github.com/b/two/pull/2');
});
