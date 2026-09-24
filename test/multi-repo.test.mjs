import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWatch, readWatch } from '../lib/watch.mjs';
import { buildOutpostPayload, sendOutposts } from '../lib/outpost.mjs';

const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-09-20T13:00:00.000Z' };

const locks = {
  acquireLock: () => ({ ok: true, token: 'test-lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
};

// Schema v2 snapshot-wide meta is mandatory -- see lib/snapshot.mjs.
const DEFAULT_OLD_META = {
  schemaVersion: 2,
  ghDeltaVersion: '0.0.0-test',
  repo: 'a/one',
  monitorId: 'i9',
  entities: ['pr'],
  scope: 'poll',
  horizon: '2026-09-20T11:00:00.000Z',
  createdAt: '2026-09-20T11:00:00.000Z',
  updatedAt: '2026-09-20T11:00:00.000Z',
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
      readSnapshot: (path) => snapshots.get(path) ?? { pr: {}, issue: {}, meta: DEFAULT_OLD_META },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => ({
        rows: repo === 'a/one' ? [pr(1, 'one')] : [pr(2, 'two')],
        rateLimit: RATE_LIMIT,
      }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );

  assert.equal(result.code, 10);
  assert.deepEqual(result.report.repos, ['a/one', 'b/two']);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.repo),
    ['a/one', 'b/two'],
  );
  assert.equal(Object.hasOwn(result.report, 'errors'), false);
  assert.ok(result.report.results.every((row) => !row.error));
  assert.equal(result.report.filteredDeltas, 0);
  assert.deepEqual(result.report.warnings, []);
  assert.equal(result.report.summary, '2 delta(s) across 2 repo(s); 0 error(s)');
  assert.equal(snapshots.size, 2);
});

test('multi-repo rejects one state file before attempting a repository tick', () => {
  let fetched = 0;
  const result = run(['--repo', 'a/one,b/two', '--state-file', '/tmp/one.json'], {
    fetchPRs: () => {
      fetched++;
      return { rows: [], rateLimit: RATE_LIMIT };
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
      readSnapshot: (path) => snapshots.get(path) ?? { pr: {}, issue: {}, meta: DEFAULT_OLD_META },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => {
        if (repo === 'a/one') throw new Error('temporary GitHub failure');
        return { rows: [pr(2, 'two')], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.repo),
    ['b/two'],
  );
  assert.equal(Object.hasOwn(result.report, 'errors'), false);
  assert.deepEqual(
    result.report.results.map((row) => [row.repo, row.error]),
    [
      [
        'a/one',
        {
          kind: 'github',
          message: 'temporary GitHub failure',
          hint: 'Check gh authentication and connectivity with gh-delta doctor, then retry.',
        },
      ],
      ['b/two', undefined],
    ],
  );
  assert.equal(snapshots.size, 1);
});

// The explicit R3 acceptance test: a multi-repo tick with one auth (permanent)
// failure exits 2, the error is visible ONLY under its own results[] entry,
// and there is no top-level `errors` key anywhere on the report.
test('multi-repo with one permanent auth failure exits 2 with the error scoped to its own results[] entry', () => {
  const snapshots = new Map();
  const result = run(
    [
      '--repo',
      'a/one,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/i9-auth',
      '--entities',
      'pr',
    ],
    {
      ...locks,
      now: () => '2026-09-20T12:00:00.000Z',
      readSnapshot: (path) => snapshots.get(path) ?? { pr: {}, issue: {}, meta: DEFAULT_OLD_META },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => {
        if (repo === 'a/one') throw { code: 'ENOENT', message: 'bad credentials' };
        return { rows: [pr(2, 'two')], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );

  assert.equal(result.code, 1, 'a plain github fetch failure is transient, not permanent');
  assert.equal(Object.hasOwn(result.report, 'errors'), false);
  assert.equal(result.report.results[0].repo, 'a/one');
  assert.ok(result.report.results[0].error);
  assert.equal(result.report.results[1].error, undefined);

  // Same shape, but with a permanent (exit-2) per-repo failure kind (a
  // corrupted snapshot -- ERROR_EXIT_CODES maps `snapshot` to 2).
  const permanent = run(
    [
      '--repo',
      'a/one,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/i9-auth-permanent',
      '--entities',
      'pr',
    ],
    {
      ...locks,
      now: () => '2026-09-20T12:00:00.000Z',
      readSnapshot: (path) => {
        if (path.includes('a%2Fone')) throw new Error('invalid snapshot JSON');
        return snapshots.get(path) ?? { pr: {}, issue: {}, meta: DEFAULT_OLD_META };
      },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: () => ({ rows: [pr(2, 'two')], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );

  assert.equal(permanent.code, 2);
  assert.equal(Object.hasOwn(permanent.report, 'errors'), false);
  const failedRow = permanent.report.results.find((row) => row.repo === 'a/one');
  const okRow = permanent.report.results.find((row) => row.repo === 'b/two');
  assert.equal(failedRow.error.kind, 'snapshot');
  assert.equal(okRow.error, undefined);
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
          return { rows: [], rateLimit: RATE_LIMIT };
        },
        fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
        writeSnapshotAtomic: () => written++,
        env: { GH_DELTA_NO_REGISTRY: '1' },
      },
    );
    assert.equal(result.code, 2);
    assert.match(
      result.report.results[0].error.message,
      /duplicate effective watch entry a\/one:pr:42/,
    );
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

test('aggregate outposts use the delta repository for identity', () => {
  const payload = buildOutpostPayload({
    report: { monitorId: 'i9', detectedAt: '2026-09-20T12:00:00.000Z' },
    delta: {
      id: 'f'.repeat(64),
      repo: 'b/two',
      entity: 'pr',
      number: 2,
      context: { title: 'two' },
      classes: ['new'],
      to: { state: 'OPEN' },
    },
  });
  assert.equal(payload.delta.repo, 'b/two');
  assert.match(payload.deliveryId, /:b\/two:/);
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
