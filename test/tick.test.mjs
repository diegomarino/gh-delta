// Tick wrapper tests: scheduled agents get heartbeat text and suggested actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick } from '../gh-delta-tick.mjs';

function reportWithDeltas({ code = 10, deltas = [] } = {}) {
  return {
    code,
    report: {
      baseline: false,
      repo: 'owner/repo',
      branch: 'watch',
      at: '2026-07-01T10:05:00.000Z',
      deltas,
      summary: `${deltas.length} delta(s)`,
    },
  };
}

const issueDelta = {
  entity: 'issue',
  number: 17,
  title: 'Backfill customer imports',
  classes: ['relabeled'],
  from: {
    state: 'OPEN',
    updatedAt: '2026-07-01T09:00:00.000Z',
    labels: ['worker'],
    comments: 0,
    commentsOverflow: false,
  },
  to: {
    state: 'OPEN',
    updatedAt: '2026-07-01T10:05:00.000Z',
    labels: ['backend', 'worker'],
    comments: 0,
    commentsOverflow: false,
  },
  line: 'ISSUE #17 "Backfill customer imports": relabeled',
};

const prDelta = {
  entity: 'pr',
  number: 42,
  title: 'Add billing webhook',
  classes: ['ci-changed', 'review-changed'],
  from: {
    state: 'OPEN',
    updatedAt: '2026-07-01T09:00:00.000Z',
    isDraft: false,
    ci: 'old',
    review: 'REVIEW_REQUIRED',
    reviews: 'old',
    mergeable: 'UNKNOWN',
    comments: 0,
    commentsOverflow: false,
    head: 'sha1',
  },
  to: {
    state: 'OPEN',
    updatedAt: '2026-07-01T10:05:00.000Z',
    isDraft: false,
    ci: 'new',
    review: 'APPROVED',
    reviews: 'new',
    mergeable: 'UNKNOWN',
    comments: 0,
    commentsOverflow: false,
    head: 'sha1',
  },
  line: 'PR #42 "Add billing webhook": ci-changed, review-changed',
};

test('baseline tick prints a heartbeat and baseline note', async () => {
  const detector = () => ({
    code: 0,
    report: {
      baseline: true,
      repo: 'owner/repo',
      branch: 'watch',
      at: '2026-07-01T10:00:00.000Z',
      deltas: [],
      summary: 'baseline established: 1 PRs, 2 issues',
    },
  });

  const { code, output } = await runTick(
    ['--repo', 'owner/repo', '--state-file', '/tmp/watch.json'],
    {
      detector,
      now: () => '2026-07-01T10:00:00.000Z',
    },
  );

  assert.equal(code, 0);
  assert.match(output, /2026-07-01T10:00:00.000Z \| 0 delta\(s\)/);
  assert.match(output, /Baseline seeded/);
});

test('delta tick prints each delta with suggested action', async () => {
  const detector = () => ({
    code: 10,
    report: {
      baseline: false,
      repo: 'owner/repo',
      branch: 'watch',
      at: '2026-07-01T10:05:00.000Z',
      deltas: [
        {
          entity: 'pr',
          number: 42,
          title: 'Add billing webhook',
          classes: ['ci-changed', 'review-changed'],
          line: 'PR #42 "Add billing webhook": ci-changed, review-changed',
        },
        {
          entity: 'issue',
          number: 17,
          title: 'Backfill customer imports',
          classes: ['relabeled'],
          line: 'ISSUE #17 "Backfill customer imports": relabeled',
        },
        {
          entity: 'pr',
          number: 8,
          title: '(missing from current fetch)',
          classes: ['still-missing'],
          line: 'PR #8 "(missing from current fetch)": still-missing',
        },
      ],
      summary: '3 delta(s)',
    },
  });

  const { code, output } = await runTick(
    ['--repo', 'owner/repo', '--state-file', '/tmp/watch.json'],
    {
      detector,
      now: () => '2026-07-01T10:05:00.000Z',
    },
  );

  assert.equal(code, 10);
  assert.match(output, /2026-07-01T10:05:00.000Z \| 3 delta\(s\)/);
  assert.match(output, /PR #42 "Add billing webhook"/);
  assert.match(output, /suggested action: CI\/review changed/);
  assert.match(output, /ISSUE #17 "Backfill customer imports"/);
  assert.match(output, /suggested action: scope\/state changed/);
  assert.match(output, /PR #8 "\(missing from current fetch\)"/);
  assert.match(output, /suggested action: object is still absent/);
});

test('error tick reports snapshot-preserving failure', async () => {
  const detector = () => ({
    code: 1,
    report: {
      error: 'gh: API rate limit exceeded',
      repo: 'owner/repo',
      at: '2026-07-01T10:10:00.000Z',
    },
  });

  const { code, output } = await runTick(
    ['--repo', 'owner/repo', '--state-file', '/tmp/watch.json'],
    {
      detector,
      now: () => '2026-07-01T10:10:00.000Z',
    },
  );

  assert.equal(code, 1);
  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /gh: API rate limit exceeded/);
  assert.match(output, /Snapshot was not updated/);
});

test('tick asks the detector for detailed delta lines by default', async () => {
  let capturedArgs;
  const detector = (args) => {
    capturedArgs = args;
    return {
      code: 0,
      report: {
        baseline: false,
        repo: 'owner/repo',
        at: '2026-07-01T10:15:00.000Z',
        deltas: [],
        summary: '0 delta(s)',
      },
    };
  };

  await runTick(['--repo', 'owner/repo', '--state-file', '/tmp/watch.json'], { detector });

  assert.ok(capturedArgs.includes('--detail'));
});

test('tick catches detector argument exceptions', async () => {
  const { code, output } = await runTick(
    ['--repo', 'owner/repo', '--state-file', '/tmp/watch.json'],
    {
      detector: () => {
        throw new Error('Unknown option --bogus');
      },
      now: () => '2026-07-01T10:20:00.000Z',
    },
  );
  assert.equal(code, 1);
  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /Unknown option --bogus/);
});

test('outpost URL sends one JSON POST per delta on code 10', async () => {
  const posts = [];
  let capturedArgs;
  const detector = (args) => {
    capturedArgs = args;
    return reportWithDeltas({ deltas: [issueDelta, prDelta] });
  };
  const outpostFetch = async (url, options) => {
    posts.push({ url, options, body: JSON.parse(options.body) });
    assert.ok(options.signal);
    return { ok: true, status: 202 };
  };

  const { code, output } = await runTick(
    [
      '--repo',
      'owner/repo',
      '--branch',
      'watch',
      '--state-file',
      '/tmp/watch.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    { detector, outpostFetch },
  );

  assert.equal(code, 10);
  assert.equal(posts.length, 2);
  assert.deepEqual(capturedArgs, [
    '--repo',
    'owner/repo',
    '--branch',
    'watch',
    '--state-file',
    '/tmp/watch.json',
    '--detail',
  ]);
  assert.equal(posts[0].url, 'https://example.com/gh-delta');
  assert.equal(posts[0].options.method, 'POST');
  assert.equal(posts[0].options.headers['Content-Type'], 'application/json');
  assert.equal(posts[0].body.type, 'gh-delta.delta');
  assert.equal(posts[0].body.schemaVersion, 1);
  assert.equal(
    posts[0].body.eventId,
    'gh-delta.delta.v1:owner/repo:watch:issue:17:relabeled:2026-07-01T10:05:00.000Z',
  );
  assert.equal(posts[0].body.repo, 'owner/repo');
  assert.equal(posts[0].body.branch, 'watch');
  assert.equal(posts[0].body.detectedAt, '2026-07-01T10:05:00.000Z');
  assert.equal(posts[0].body.entity, 'issue');
  assert.equal(posts[0].body.number, 17);
  assert.equal(posts[0].body.title, 'Backfill customer imports');
  assert.deepEqual(posts[0].body.classes, ['relabeled']);
  assert.equal(posts[0].body.state, 'OPEN');
  assert.deepEqual(posts[0].body.labels, ['backend', 'worker']);
  assert.equal(posts[0].body.line, 'ISSUE #17 "Backfill customer imports": relabeled');
  assert.deepEqual(posts[0].body.delta, { from: issueDelta.from, to: issueDelta.to });
  assert.deepEqual(posts[0].body.links, { html: 'https://github.com/owner/repo/issues/17' });
  assert.deepEqual(posts[1].body.labels, []);
  assert.deepEqual(posts[1].body.links, { html: 'https://github.com/owner/repo/pull/42' });
  assert.doesNotMatch(output, /outpost warning/);
});

test('outpost URL does not POST on code 0 or code 1', async () => {
  let posts = 0;
  const outpostFetch = async () => {
    posts++;
    return { ok: true, status: 202 };
  };

  await runTick(
    [
      '--repo',
      'owner/repo',
      '--state-file',
      '/tmp/watch.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    {
      detector: () => reportWithDeltas({ code: 0, deltas: [] }),
      outpostFetch,
    },
  );
  await runTick(
    [
      '--repo',
      'owner/repo',
      '--state-file',
      '/tmp/watch.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    {
      detector: () => ({
        code: 1,
        report: {
          error: 'gh: API rate limit exceeded',
          repo: 'owner/repo',
          at: '2026-07-01T10:10:00.000Z',
        },
      }),
      outpostFetch,
    },
  );

  assert.equal(posts, 0);
});

test('invalid outpost URL returns code 1 before detector fetch', async () => {
  let detectorCalled = false;
  const { code, output } = await runTick(
    [
      '--repo',
      'owner/repo',
      '--state-file',
      '/tmp/watch.json',
      '--outpost-url',
      'ftp://example.com/gh-delta',
    ],
    {
      detector: () => {
        detectorCalled = true;
        throw new Error('should not fetch');
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(detectorCalled, false);
  assert.match(output, /--outpost-url must use http: or https:/);
});

test('outpost POST failure warns without changing code 10 or leaking URL secrets', async () => {
  const { code, output } = await runTick(
    [
      '--repo',
      'owner/repo',
      '--state-file',
      '/tmp/watch.json',
      '--outpost-url',
      'https://example.com/gh-delta?token=supersecret',
    ],
    {
      detector: () => reportWithDeltas({ deltas: [issueDelta] }),
      outpostFetch: async () => ({ ok: false, status: 500, statusText: 'Server Error' }),
    },
  );

  assert.equal(code, 10);
  assert.match(output, /outpost warning: ISSUE #17 failed: HTTP 500/);
  assert.doesNotMatch(output, /supersecret/);
  assert.doesNotMatch(output, /example\.com/);
});
