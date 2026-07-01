// CLI contract tests: exit codes, snapshot safety, and user-facing detail output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../gh-delta.mjs';

const basePr = {
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'sha1',
};

function deps(prSeq, { existing = null } = {}) {
  let writes = 0;
  let stored = existing;
  return {
    fetchPRs: () => prSeq.shift(),
    fetchIssues: () => [],
    readSnapshot: () => stored,
    writeSnapshotAtomic: (_p, d) => {
      writes++;
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
    get writes() {
      return writes;
    },
    get stored() {
      return stored;
    },
  };
}

test('first run returns code 0 (baseline) and writes the snapshot', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.baseline, true);
  assert.equal(d.writes, 1);
});

test('a delta returns code 10 and rewrites the snapshot', () => {
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          commentsOverflow: false,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const { code, report } = run(
    ['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 10);
  assert.ok(report.deltas.some((x) => x.classes.includes('merged')));
});

test('no change returns code 0 and still refreshes snapshot', () => {
  const seed = { pr: {}, issue: {} };
  const d = deps([[]], { existing: seed });
  const { code } = run(['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
});

test('a gh failure returns code 1 and does NOT write the snapshot', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => [],
    readSnapshot: () => ({ pr: {}, issue: {} }),
    writeSnapshotAtomic: () => {
      throw new Error('should not be called');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code } = run(['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 1);
});

test('--detail attaches a human line to each delta', () => {
  const d = deps([[{ ...basePr, comments: [{}, {}], updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'x',
          review: 'REVIEW_REQUIRED',
          reviews: 'y',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.ok(report.deltas[0].line.includes('#42'));
});

test('--help returns usage text without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help'], d);
  assert.equal(code, 0);
  assert.equal(typeof report, 'string');
  assert.ok(report.includes('Usage:'));
});

test('missing --repo returns code 1 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--state-file', '/tmp/x.json'], d);
  assert.equal(code, 1);
  assert.match(report.error, /--repo/);
});

test('missing --state-file returns code 1 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--repo', 'o/r'], d);
  assert.equal(code, 1);
  assert.match(report.error, /--state-file/);
});

test('invalid --entities returns code 1 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(
    ['--repo', 'o/r', '--state-file', '/tmp/x.json', '--entities', 'release'],
    d,
  );
  assert.equal(code, 1);
  assert.match(report.error, /--entities/);
});

test('unknown arguments return structured code 1 error', () => {
  const { code, report } = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', '--bogus'], {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  });
  assert.equal(code, 1);
  assert.match(report.error, /Unknown option|--bogus/);
});

test('--entities pr preserves existing issue snapshot entries', () => {
  const existing = {
    pr: {
      42: {
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        isDraft: false,
        ci: 'da39a3ee5e6b',
        review: 'REVIEW_REQUIRED',
        reviews: 'da39a3ee5e6b',
        mergeable: 'UNKNOWN',
        comments: 0,
        head: 'sha1',
      },
    },
    issue: { 7: { state: 'OPEN', updatedAt: '2026-07-01T10:00:00Z', labels: [], comments: 0 } },
  };
  const d = deps([[basePr]], { existing });
  const { code } = run(
    ['--repo', 'o/r', '--branch', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.ok(d.stored.issue['7']);
});

test('corrupt snapshot read failure returns code 1 and does NOT write', () => {
  let writes = 0;
  const { code, report } = run(['--repo', 'o/r', '--state-file', '/tmp/x.json'], {
    fetchPRs: () => [basePr],
    fetchIssues: () => [],
    readSnapshot: () => {
      throw new Error('invalid snapshot JSON at /tmp/x.json');
    },
    writeSnapshotAtomic: () => {
      writes++;
    },
    now: () => '2026-07-01T12:00:00Z',
  });
  assert.equal(code, 1);
  assert.equal(writes, 0);
  assert.match(report.error, /invalid snapshot JSON/);
});

test('gh-delta --outpost-url sends code 10 deltas after the snapshot write', async () => {
  const { runWithOutpost } = await import('../gh-delta.mjs');
  assert.equal(typeof runWithOutpost, 'function');
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          commentsOverflow: false,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 202 };
  };

  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--branch',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    d,
  );

  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://example.com/gh-delta');
  assert.equal(posts[0].body.type, 'gh-delta.delta');
  assert.equal(
    posts[0].body.eventId,
    'gh-delta.delta.v1:o/r:main:pr:42:merged:2026-07-01T12:00:00Z',
  );
});

test('gh-delta rejects invalid --outpost-url before fetching GitHub', async () => {
  const { runWithOutpost } = await import('../gh-delta.mjs');
  assert.equal(typeof runWithOutpost, 'function');
  let fetches = 0;
  const { code, report } = await runWithOutpost(
    ['--repo', 'o/r', '--state-file', '/tmp/x.json', '--outpost-url', 'file:///tmp/outpost.json'],
    {
      fetchPRs: () => {
        fetches++;
        throw new Error('should not fetch');
      },
      fetchIssues: () => [],
      readSnapshot: () => ({ pr: {}, issue: {} }),
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 1);
  assert.equal(fetches, 0);
  assert.match(report.error, /--outpost-url must use http: or https:/);
});
