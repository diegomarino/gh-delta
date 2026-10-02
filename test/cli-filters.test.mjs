// CLI contract tests: attention filters, --ignore-authors, and --settled.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basePr,
  item,
  RATE_LIMIT,
  deps,
  FILTER_ARGS,
  threadReplyFixture,
} from './helpers/cli-fixtures.mjs';
import { run } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';

test('--ignore-authors suppresses fully covered bot comments but advances the snapshot', () => {
  const before = {
    ...basePr,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'GitHub-Actions[bot]' },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const result = run([...FILTER_ARGS, '--ignore-authors', 'github-actions[bot]'], d);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
  assert.equal(result.report.filteredDeltas, 1);
  assert.equal(d.stored.pr['42'].fingerprint.conversationComments, 2);
});

test('--ignore-authors fails open and --detail is opaque for an unusable new comment row', () => {
  const before = {
    ...basePr,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: null, author: null },
    ],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const filtered = run(
    [...FILTER_ARGS, '--ignore-authors', 'human'],
    deps([[after]], { existing }),
  );
  assert.equal(filtered.code, 10);
  assert.ok(filtered.report.deltas[0].classes.includes('new-comments'));
  assert.equal(filtered.report.filteredDeltas, 0);
  const detailed = run([...FILTER_ARGS, '--detail'], deps([[after]], { existing })).report
    .deltas[0];
  const comments = detailed.details.find((row) => row.class === 'new-comments');
  assert.equal(comments.opaque, true);
  assert.equal(comments.added, undefined);
});

// F1 note: this used to guard against the aggregate `comments` counter
// (conversation + review combined) tripping `new-comments` on a
// non-conversation (review thread reply) rise, which made the old
// commentAuthorsIgnored's cross-check opaque. The comment-model split makes
// that scenario structurally impossible now: a review-only rise moves only
// reviewComments and fires review-comments-added, never new-comments.
test('a review-only comment rise (conversationComments unchanged) never fires new-comments', () => {
  const before = {
    ...basePr,
    conversationComments: 1,
    reviewComments: 0,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    conversationComments: 1,
    reviewComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const result = run(FILTER_ARGS, deps([[after]], { existing }));
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-comments-added'));
  assert.ok(!result.report.deltas[0].classes.includes('new-comments'));
});

test('--number scope excludes a non-selected PR before the --ignore-authors thread-reply fetch, not after', () => {
  const { before: before42, after: after42 } = threadReplyFixture(1, 1);
  const { before: before99, after: after99 } = threadReplyFixture(1, 3);
  const existing = {
    pr: { 42: item(prFingerprint(before42)), 99: item(prFingerprint(before99)) },
    issue: {},
  };
  const d = deps(
    [
      [
        { ...after42, number: 42 },
        { ...after99, number: 99 },
      ],
    ],
    { existing },
  );
  d.fetchThreadReplies = () => {
    throw new Error('must not be called: PR #99 is outside the --number 42 selection');
  };
  const result = run(
    [...FILTER_ARGS, '--number', '42', '--ignore-authors', 'bot', '--enrich', 'thread-replies'],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.number),
    [42],
  );
  assert.ok(!result.report.deltas[0].classes.includes('review-comments-added'));
  assert.deepEqual(
    result.warnings.filter((w) => /thread-repl/i.test(w.label)),
    [],
  );
});

test('--ignore-authors fails open on review-changed when reviewDecision itself moved, even if a changed review row is ignored', () => {
  const before = {
    ...basePr,
    reviewDecision: 'review_required',
    reviews: [],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewDecision: 'approved',
    reviews: [{ id: 'R1', author: 'bot', state: 'approved', submittedAt: 'now', commit: 'a' }],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'bot'], deps([[after]], { existing }));
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-changed'));
});

test('--ignore-authors fails open on review-changed with no attributable review row', () => {
  // reviewDecision moves while the reviews[] array is byte-identical (e.g. a
  // branch-protection recompute) -- changedOrNewReviews finds nothing to
  // attribute, so review-changed must survive regardless of --ignore-authors.
  const reviews = [
    { id: 'R1', author: 'alice', state: 'approved', submittedAt: 'now', commit: 'a' },
  ];
  const before = { ...basePr, reviewDecision: 'review_required', reviews };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewDecision: 'approved',
    reviews,
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'alice'], deps([[after]], { existing }));
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-changed'));
});

test('quota-safety regression: a failing publish with the double opt-in spends only the pre-publish thread-replies call', () => {
  const { before, after } = threadReplyFixture(1, 3);
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const d = deps([[after]], { existing });
  let preFetchCalls = 0;
  let postFetchCalls = 0;
  d.fetchThreadReplies = () => {
    preFetchCalls++;
    return {
      rows: [{ id: 'T1', replies: [{ id: 'C1', author: 'human', createdAt: 'now', body: 'x' }] }],
      rateLimit: RATE_LIMIT,
    };
  };
  d.fetchEnrichment = () => {
    postFetchCalls++;
    return { rows: [], rateLimit: RATE_LIMIT };
  };
  d.writeSnapshotAtomic = () => {
    throw new Error('disk full');
  };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'bot', '--enrich', 'thread-replies'], d);
  assert.equal(result.code, 1);
  assert.equal(preFetchCalls, 1);
  assert.equal(postFetchCalls, 0);
});

test('class filters run before ignored authors and filteredDeltas excludes surviving class removal', () => {
  const before = {
    ...basePr,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'github-actions[bot]' },
    ],
  };
  const result = run(
    [
      ...FILTER_ARGS,
      '--only-classes',
      'new-comments',
      '--ignore-classes',
      'ci-changed',
      '--ignore-authors',
      'github-actions[bot]',
    ],
    deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } }),
  );
  assert.equal(result.code, 10);
  // new-comments is stripped by --ignore-authors (the only newly inferred
  // comment is bot-authored); head-changed no longer drags in a forced
  // `updated` pairing, so it is the sole survivor.
  assert.deepEqual(result.report.deltas[0].classes, ['head-changed']);
  assert.equal(result.report.filteredDeltas, 0);
});

test('--ignore-authors rejects empty members before repository derivation', () => {
  const d = deps([[]]);
  d.resolveRepo = () => {
    throw new Error('must not derive');
  };
  const { code, report } = run(['--ignore-authors', 'bot,', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.match(report.error, /--ignore-authors/);
});

test('--only-classes with no matching delta suppresses attention without changing the snapshot', () => {
  // Removing the only-class branch would incorrectly wake consumers for a
  // ci-changed delta that no requested class admits.
  const before = { ...basePr, checks: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run([...FILTER_ARGS, '--only-classes', 'review-changed'], d);
  assert.equal(code, 0);
  assert.deepEqual(report.deltas, []);
  assert.equal(report.filteredDeltas, 1);
  assert.equal(d.stored.pr['42'].fingerprint.updatedAt, after.updatedAt);
});

test('--only-classes keeps matching deltas and still exits 10', () => {
  // Dropping the positive branch would hide a requested ci transition among
  // unrelated update churn.
  const ciBefore = { ...basePr, checks: [] };
  const ciAfter = {
    ...ciBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const updateBefore = { ...basePr, number: 43, title: 'other PR' };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[ciAfter, updateAfter]], {
    existing: {
      pr: { 42: item(prFingerprint(ciBefore)), 43: item(prFingerprint(updateBefore)) },
      issue: {},
    },
  });
  const { code, report } = run([...FILTER_ARGS, '--only-classes', 'ci-changed'], d);
  assert.equal(code, 10);
  assert.equal(report.deltas.length, 1);
  assert.ok(report.deltas[0].classes.includes('ci-changed'));
  assert.equal(report.filteredDeltas, 1);
});

test('--ignore-classes removes a class but retains a multi-class delta, and drops empty deltas', () => {
  // A filter that deletes the whole multi-class delta loses an actionable head
  // change; one that retains an empty class list emits an invalid delta.
  const headBefore = { ...basePr, isDraft: true };
  const headAfter = {
    ...headBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    isDraft: false,
  };
  const retained = run(
    [...FILTER_ARGS, '--ignore-classes', 'draft-ready'],
    deps([[headAfter]], { existing: { pr: { 42: item(prFingerprint(headBefore)) }, issue: {} } }),
  );
  assert.equal(retained.code, 10);
  assert.deepEqual(retained.report.deltas[0].classes, ['head-changed']);
  assert.equal(retained.report.filteredDeltas, 0);

  const updateBefore = { ...basePr };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const dropped = run(
    [...FILTER_ARGS, '--ignore-classes', 'updated'],
    deps([[updateAfter]], {
      existing: { pr: { 42: item(prFingerprint(updateBefore)) }, issue: {} },
    }),
  );
  assert.equal(dropped.code, 0);
  assert.deepEqual(dropped.report.deltas, []);
  assert.equal(dropped.report.filteredDeltas, 1);
});

test('unknown attention-filter classes are config errors that name the invalid value', () => {
  // Accepting an unknown token silently turns a permanently misconfigured
  // watcher into an apparently healthy no-op.
  for (const flag of ['--only-classes', '--ignore-classes']) {
    const { code, report } = run([...FILTER_ARGS, flag, 'not-a-delta-class'], deps([[]]));
    assert.equal(code, 2);
    assert.equal(report.kind, 'config');
    assert.match(report.error, /not-a-delta-class/);
  }
});

test('--settled drops pending and unknown PRs, keeps ciRollup none, and implies summaries', () => {
  // Treating no CI checks as pending would suppress a settled PR forever; not
  // deriving summaries would let pending/unknown work through unnoticed.
  const pendingBefore = { ...basePr, number: 42, mergeable: 'mergeable' };
  const pendingAfter = {
    ...pendingBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'pending', conclusion: 'pending' }],
  };
  const unknownBefore = { ...basePr, number: 43, mergeable: 'mergeable' };
  const unknownAfter = {
    ...unknownBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    mergeable: 'unknown',
  };
  const noneBefore = { ...basePr, number: 44, mergeable: 'mergeable' };
  const noneAfter = { ...noneBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[pendingAfter, unknownAfter, noneAfter]], {
    existing: {
      pr: {
        42: item(prFingerprint(pendingBefore)),
        43: item(prFingerprint(unknownBefore)),
        44: item(prFingerprint(noneBefore)),
      },
      issue: {},
    },
  });
  const { code, report } = run([...FILTER_ARGS, '--settled'], d);
  assert.equal(code, 10);
  assert.deepEqual(
    report.deltas.map((delta) => delta.number),
    [44],
  );
  assert.equal(report.deltas[0].summary.ciRollup, 'none');
  assert.equal(report.filteredDeltas, 2);
});

test('combined attention filters apply only before ignore, making ignore the final class veto', () => {
  // Reversing the order would drop this delta after ci-changed is vetoed,
  // instead of retaining its independent head-changed class.
  const before = { ...basePr, checks: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    [...FILTER_ARGS, '--only-classes', 'ci-changed', '--ignore-classes', 'ci-changed'],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['head-changed']);
  assert.equal(report.filteredDeltas, 0);
});

test('attention filters leave the persisted snapshot byte-identical and outpost sends survivors only', async () => {
  // Moving filtering before persistence would replay suppressed changes later;
  // sending the unfiltered report would still wake the downstream consumer.
  const ciBefore = { ...basePr, checks: [] };
  const ciAfter = {
    ...ciBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const updateBefore = { ...basePr, number: 43, title: 'other PR' };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const stateDir = mkdtempSync(join(tmpdir(), 'gh-delta-filters-'));
  const unfilteredState = join(stateDir, 'unfiltered.json');
  const filteredState = join(stateDir, 'filtered.json');
  const argsFor = (stateFile) => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    stateFile,
  ];
  const dependencySet = (prs) => ({
    fetchPRs: () => ({ rows: prs, rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    now: () => '2026-07-01T12:00:00Z',
  });
  try {
    for (const stateFile of [unfilteredState, filteredState]) {
      const seeded = run(argsFor(stateFile), dependencySet([ciBefore, updateBefore]));
      assert.equal(seeded.code, 0);
    }
    const unfiltered = run(argsFor(unfilteredState), dependencySet([ciAfter, updateAfter]));
    assert.equal(unfiltered.code, 10);
    const filteredDeps = dependencySet([ciAfter, updateAfter]);
    const posts = [];
    filteredDeps.outpostFetch = async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    };
    const { runWithOutpost } = await import('../lib/cli.mjs');
    const filtered = await runWithOutpost(
      [
        ...argsFor(filteredState),
        '--only-classes',
        'updated',
        '--outpost-url',
        'https://example.com/gh-delta',
      ],
      filteredDeps,
    );
    assert.equal(filtered.code, 10);
    assert.deepEqual(
      filtered.report.deltas.map((delta) => delta.number),
      [43],
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0].delta.number, 43);
    assert.equal(readFileSync(filteredState, 'utf8'), readFileSync(unfilteredState, 'utf8'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
