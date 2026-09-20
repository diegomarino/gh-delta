import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWatch, readWatch } from '../lib/watch.mjs';
import { buildOutpostPayload, sendOutposts } from '../lib/outpost.mjs';

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

test('a single-repo run rejects legacy and scoped watch aliases before fetch or write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-i9-duplicate-watch-'));
  try {
    addWatch(dir, 'pr:42', 'merged', { now: () => '2026-09-20T12:00:00.000Z' });
    addWatch(dir, 'pr:42', 'merged', {
      now: () => '2026-09-20T12:00:00.000Z',
      repo: 'a/one',
    });
    let fetched = 0;
    let written = 0;
    const result = run(
      ['--repo', 'a/one', '--watch-dir', dir, '--state-file', '/tmp/i9-watch.json'],
      {
        ...locks,
        now: () => '2026-09-20T12:00:00.000Z',
        fetchPRs: () => {
          fetched++;
          return [];
        },
        fetchIssues: () => [],
        writeSnapshotAtomic: () => written++,
        env: { GH_DELTA_NO_REGISTRY: '1' },
      },
    );
    assert.equal(result.code, 2);
    assert.match(result.report.error, /duplicate effective watch entry a\/one:pr:42/);
    assert.equal(fetched, 0);
    assert.equal(written, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWatch rejects malformed or noncanonical persisted scoped repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-i9-invalid-watch-'));
  try {
    for (const repo of ['A/One', 'a//one']) {
      const name = `repo-${encodeURIComponent(repo)}__pr-42.json`;
      writeFileSync(
        join(dir, name),
        `${JSON.stringify({ entity: 'pr', number: 42, repo, until: 'merged', addedAt: '2026-09-20T12:00:00.000Z' })}\n`,
      );
      assert.throws(() => readWatch(dir), /invalid watch entry/);
      rmSync(join(dir, name));
    }
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

test('aggregate outpost failures qualify same-number items with their repository', async () => {
  const { warnings } = await sendOutposts({
    outpostUrl: 'https://example.test/hook',
    report: {
      repos: ['a/one', 'b/two'],
      monitorId: 'i9',
      deltas: [
        { repo: 'a/one', entity: 'pr', number: 42, title: 'one', classes: ['new'] },
        { repo: 'b/two', entity: 'pr', number: 42, title: 'two', classes: ['new'] },
      ],
    },
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.deepEqual(warnings, [
    { label: 'a/one: PR #42', reason: 'HTTP 500' },
    { label: 'b/two: PR #42', reason: 'HTTP 500' },
  ]);
});

test('aggregate outpost caps group skipped warnings by repository in flattened order', async () => {
  const { warnings } = await sendOutposts({
    outpostUrl: 'https://example.test/hook',
    maxPosts: 1,
    report: {
      repos: ['a/one', 'b/two', 'c/three'],
      monitorId: 'i9',
      deltas: [
        { repo: 'a/one', entity: 'pr', number: 1, title: 'one', classes: ['new'] },
        { repo: 'b/two', entity: 'pr', number: 2, title: 'two', classes: ['new'] },
        { repo: 'c/three', entity: 'pr', number: 3, title: 'three', classes: ['new'] },
      ],
    },
    fetchImpl: async () => ({ ok: true, status: 202 }),
  });
  assert.deepEqual(warnings, [
    { label: 'b/two: outpost', reason: 'skipped 1 delta(s) after max outpost post count 1' },
    { label: 'c/three: outpost', reason: 'skipped 1 delta(s) after max outpost post count 1' },
  ]);
});
