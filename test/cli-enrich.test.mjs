// CLI contract tests: --enrich decoration after snapshot publication.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('--ignore-authors suppresses review-comments-added when --enrich thread-replies supplies the reply authors', () => {
  const { before, after } = threadReplyFixture(1, 3);
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const d = deps([[after]], { existing });
  const calls = [];
  const logged = [];
  d.appendDeltaLog = (_file, record) => {
    logged.push(record);
    return { fromSeq: 1, toSeq: record.deltas.length, appended: record.deltas.length };
  };
  d.fetchThreadReplies = (entries) => {
    calls.push(entries);
    return {
      rows: [
        {
          id: 'T1',
          replies: [
            { id: 'C1', author: 'bot', createdAt: 'now', body: 'x' },
            { id: 'C2', author: 'bot', createdAt: 'now', body: 'y' },
          ],
        },
      ],
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    [...FILTER_ARGS, '--ignore-authors', 'bot', '--enrich', 'thread-replies', '--log'],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
  assert.deepEqual(calls, [[{ id: 'T1', increment: 2, total: 3 }]]);
  // The suppressed delta never reaches the durable log: filtering happens
  // before appendDeltaLog is called.
  assert.deepEqual(
    logged.flatMap((r) => r.deltas),
    [],
  );
});

test('--ignore-authors warns explicitly (fail open) for review-comments-added without --enrich thread-replies', () => {
  const { before, after } = threadReplyFixture(1, 3);
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'bot'], deps([[after]], { existing }));
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-comments-added'));
  assert.ok(
    result.warnings.some((w) => /thread-repl/i.test(w.label) || /thread-repl/i.test(w.reason)),
  );
});

test('--ignore-authors + --enrich thread-replies warns (does not silently suppress) when review-comments-added comes entirely from a brand-new thread', () => {
  const before = { ...basePr, reviewComments: 0, threads: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewComments: 3,
    threads: [{ id: 'T-new', resolved: false, comments: 3 }],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const d = deps([[after]], { existing });
  d.fetchThreadReplies = () => {
    throw new Error('must not be called: no threads have a prior baseline to diff');
  };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'bot', '--enrich', 'thread-replies'], d);
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-comments-added'));
  assert.ok(result.warnings.some((w) => /attributable/i.test(w.reason)));
});

test('--ignore-authors + --enrich thread-replies warns and does not suppress review-comments-added when a brand-new thread only partly explains the rise', () => {
  // T1 is established and rose by 1 (attributable, all-bot). T2 is brand new
  // this tick with 2 comments from a human -- threadReplyIncrements excludes
  // it (no prior baseline), so the fetched rows only ever cover T1's +1 out
  // of the observed +3 reviewComments rise. Suppressing on T1 alone would
  // silently drop a delta a human review reply is hiding inside.
  const before = {
    ...basePr,
    reviewComments: 1,
    threads: [{ id: 'T1', resolved: false, comments: 1 }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewComments: 4,
    threads: [
      { id: 'T1', resolved: false, comments: 2 },
      { id: 'T2', resolved: false, comments: 2 },
    ],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const d = deps([[after]], { existing });
  d.fetchThreadReplies = (entries) => {
    assert.deepEqual(entries, [{ id: 'T1', increment: 1, total: 2 }]);
    return {
      rows: [{ id: 'T1', replies: [{ id: 'C1', author: 'bot', createdAt: 'now', body: 'x' }] }],
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run([...FILTER_ARGS, '--ignore-authors', 'bot', '--enrich', 'thread-replies'], d);
  assert.equal(result.code, 10);
  assert.ok(result.report.deltas[0].classes.includes('review-comments-added'));
  assert.ok(result.warnings.some((w) => /attributable/i.test(w.reason)));
});

test('--enrich decorates surviving deltas only after snapshot publication and leaves the durable log canonical', () => {
  const before = {
    ...basePr,
    reviews: [],
    conversationComments: 1,
    recentComments: [{ id: 'C1', author: 'old' }],
    threads: [{ id: 'T1', resolved: true }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewDecision: 'changes_requested',
    reviews: [
      {
        id: 'R1',
        state: 'changes_requested',
        submittedAt: 'now',
        author: 'a',
        commit: 'b',
      },
    ],
    conversationComments: 2,
    recentComments: [
      { id: 'C1', author: 'old' },
      { id: 'C2', author: 'new' },
    ],
    threads: [{ id: 'T1', resolved: false }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const order = [];
  d.writeSnapshotAtomic = (_path, value) => {
    order.push('snapshot');
    d.snapshotBytes = JSON.stringify(value);
  };
  d.appendDeltaLog = (_path, value) => {
    order.push('log');
    d.logged = value;
    return { fromSeq: 1, toSeq: value.deltas.length, appended: value.deltas.length };
  };
  d.fetchEnrichment = (kind, ids) => {
    order.push(kind);
    assert.equal(order[0], 'log');
    assert.equal(order[1], 'snapshot');
    if (kind === 'review')
      return {
        rows: [
          {
            id: ids[0],
            author: 'a',
            state: 'changes_requested',
            submittedAt: 'now',
            commit: 'b',
            body: 'fix',
          },
        ],
        rateLimit: RATE_LIMIT,
      };
    if (kind === 'comments')
      return {
        rows: [{ id: ids[0], author: 'b', createdAt: 'now', body: '@alice' }],
        rateLimit: RATE_LIMIT,
      };
    return {
      rows: [
        {
          id: ids[0],
          firstComment: {
            id: 'TC',
            author: 'c',
            createdAt: 'now',
            path: 'x',
            line: 2,
            originalLine: 1,
            body: 'body',
          },
        },
      ],
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--log',
      '--enrich',
      'review,comments,threads',
    ],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(order, ['log', 'snapshot', 'review', 'comments', 'threads']);
  assert.deepEqual(Object.keys(result.report.deltas[0].enrichment).sort(), [
    'comments',
    'review',
    'threads',
  ]);
  assert.equal(JSON.stringify(d.logged).includes('enrichment'), false);
  assert.equal(d.snapshotBytes.includes('enrichment'), false);
  assert.match(result.report.deltas[0].enrichment.comments[0].mentions[0], /alice/);
});

test("with --log and --enrich, the delivered outpost payload seq matches that delta's journal record (R4 seq binding)", async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const before = { ...basePr, reviews: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewDecision: 'changes_requested',
    reviews: [
      { id: 'R1', state: 'changes_requested', submittedAt: 'now', author: 'a', commit: 'b' },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  // A non-trivial fromSeq (not 1) proves the payload's seq is the delta's own
  // journal record number, not an off-by-one or a hardcoded first-record guess.
  d.appendDeltaLog = (_path, value) => ({
    fromSeq: 5,
    toSeq: 5 + value.deltas.length - 1,
    appended: value.deltas.length,
  });
  d.fetchEnrichment = (_kind, ids) => ({
    rows: [
      {
        id: ids[0],
        author: 'a',
        state: 'changes_requested',
        submittedAt: 'now',
        commit: 'b',
        body: 'fix',
      },
    ],
    rateLimit: RATE_LIMIT,
  });
  const posts = [];
  d.outpostFetch = async (_url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };

  const result = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--log',
      '--enrich',
      'review',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    d,
  );

  assert.equal(result.code, 10);
  assert.equal(result.report.deltas[0].seq, 5);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].seq, 5);
  // The delivered delta must be the ENRICHED one, even though the seq comes
  // from the pre-enrichment journal write -- the two are sourced from the
  // same object at different points in the pipeline, not from a snapshot
  // taken at the same time.
  assert.ok(posts[0].delta.enrichment?.review);
});

test('--enrich invalid selection is rejected before repository derivation', () => {
  let derived = false;
  const result = run(['--enrich', 'review,', '--state-file', '/tmp/x.json'], {
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      derived = true;
      throw new Error('must not derive');
    },
  });
  assert.equal(result.code, 2);
  assert.equal(derived, false);
  assert.match(result.report.error, /--enrich/);
});

test('every delta carries author and url from snapshot context without any flags (F2)', () => {
  const before = { ...basePr, author: 'octocat', url: 'https://github.com/o/r/pull/42' };
  const after = { ...before, updatedAt: '2026-07-01T11:00:00Z', conversationComments: 1 };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 10);
  assert.equal(result.report.deltas[0].context.author, 'octocat');
  assert.equal(result.report.deltas[0].context.url, 'https://github.com/o/r/pull/42');
});

test('--enrich body fetches the body of a new PR in one nodes() call and attaches mentions', () => {
  const newPr = { ...basePr, id: 'PR_node42', author: 'octocat' };
  // A non-baseline tick (existing snapshot present, just missing this number)
  // so the new PR classifies as `new`, not a silently seeded baseline.
  const d = deps([[newPr]], { existing: { pr: {}, issue: {} } });
  const calls = [];
  d.fetchEnrichment = (kind, ids) => {
    calls.push({ kind, ids });
    return {
      rows: [{ id: ids[0], body: 'please review @alice' }],
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--enrich', 'body'],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].classes, ['new']);
  assert.deepEqual(calls, [{ kind: 'body', ids: ['PR_node42'] }]);
  assert.deepEqual(result.report.deltas[0].enrichment.body, {
    body: 'please review @alice',
    mentions: ['alice'],
  });
});

test('--enrich body makes zero calls for a new-comments-only delta', () => {
  const before = { ...basePr, id: 'PR_node42' };
  const after = { ...before, updatedAt: '2026-07-01T11:00:00Z', conversationComments: 1 };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  let calls = 0;
  d.fetchEnrichment = () => {
    calls++;
    return { rows: [], rateLimit: RATE_LIMIT };
  };
  const result = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--enrich', 'body'],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].classes, ['new-comments']);
  assert.equal(calls, 0);
  assert.equal(result.report.deltas[0].enrichment, undefined);
});
