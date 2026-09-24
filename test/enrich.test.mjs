import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichEmittedDeltas, extractMentions } from '../lib/enrich.mjs';

// Schema v2: `from`/`to` on a delta are the bare compared fingerprint, not the
// full snapshot item -- identity for `body` enrichment comes from the delta's
// own top-level `context.id`, never from a from/to wrapper.

test('enrichment uses final delta identities, keeps successful siblings, and preserves mention order', () => {
  const delta = {
    classes: ['review-changed', 'new-comments', 'unresolved-threads-added'],
    from: {
      reviews: [{ id: 'R1', state: 'changes_requested', submittedAt: 'old', commit: 'a' }],
      conversationComments: 1,
      recentComments: [{ id: 'C1', author: 'old' }],
      threads: [{ id: 'T1', resolved: true }],
    },
    to: {
      reviews: [{ id: 'R1', state: 'changes_requested', submittedAt: 'new', commit: 'b' }],
      conversationComments: 2,
      recentComments: [
        { id: 'C1', author: 'old' },
        { id: 'C2', author: 'new' },
      ],
      threads: [{ id: 'T1', resolved: false }],
    },
  };
  const calls = [];
  const { warnings, rateLimit } = enrichEmittedDeltas([delta], ['review', 'comments', 'threads'], {
    fetch(kind, ids) {
      calls.push({ kind, ids });
      if (kind === 'review')
        return {
          rows: [
            {
              id: 'R1',
              author: 'a',
              state: 'changes_requested',
              submittedAt: 'new',
              commit: 'b',
              body: 'fix',
            },
          ],
          rateLimit: { cost: 1, remaining: 99, resetAt: '2026-07-01T13:00:00.000Z' },
        };
      if (kind === 'comments')
        return {
          rows: [
            {
              id: 'C2',
              author: 'b',
              createdAt: 'now',
              body: 'hi @Alice and @org/team, x@y.com @alice',
            },
          ],
          rateLimit: { cost: 1, remaining: 98, resetAt: '2026-07-01T13:00:01.000Z' },
        };
      return {
        rows: [
          {
            id: 'T1',
            firstComment: {
              id: 'TC1',
              author: 'c',
              createdAt: 'now',
              path: 'x',
              line: 2,
              originalLine: 1,
              body: 'body',
            },
          },
        ],
        rateLimit: { cost: 1, remaining: 97, resetAt: '2026-07-01T13:00:02.000Z' },
      };
    },
  });
  assert.deepEqual(calls, [
    { kind: 'review', ids: ['R1'] },
    { kind: 'comments', ids: ['C2'] },
    { kind: 'threads', ids: ['T1'] },
  ]);
  assert.deepEqual(delta.enrichment.comments[0].mentions, ['Alice', 'org/team']);
  assert.equal(warnings.length, 0);
  // cost accumulates across all three enrichment calls; remaining/resetAt are the last call's.
  assert.deepEqual(rateLimit, { cost: 3, remaining: 97, resetAt: '2026-07-01T13:00:02.000Z' });
});

test('enrichment skips opaque identities and turns one boundary failure into a warning', () => {
  const delta = {
    classes: ['new-comments'],
    from: { comments: 1 },
    to: { comments: 2 },
  };
  let calls = 0;
  const { warnings } = enrichEmittedDeltas([delta], ['comments'], { fetch: () => calls++ });
  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(delta.enrichment, undefined);

  const good = {
    classes: ['new-comments'],
    from: { conversationComments: 1, recentComments: [{ id: 'C1' }] },
    to: { conversationComments: 2, recentComments: [{ id: 'C1' }, { id: 'C2' }] },
  };
  const failure = enrichEmittedDeltas([good], ['comments'], {
    fetch: () => {
      throw new Error('nope');
    },
  });
  assert.equal(failure.warnings.length, 1);
  assert.equal(good.enrichment, undefined);
});

test('a zero-count prior comment fingerprint may use an absent identity window as empty', () => {
  const delta = {
    classes: ['new-comments'],
    from: { conversationComments: 0 },
    to: { conversationComments: 1, recentComments: [{ id: 'C1' }] },
  };
  const calls = [];
  const { warnings } = enrichEmittedDeltas([delta], ['comments'], {
    fetch: (kind, ids) => {
      calls.push({ kind, ids });
      return { rows: [{ id: 'C1', author: 'a', createdAt: 'now', body: 'body' }], rateLimit: null };
    },
  });
  assert.deepEqual(calls, [{ kind: 'comments', ids: ['C1'] }]);
  assert.equal(warnings.length, 0);
  assert.equal(delta.enrichment.comments[0].id, 'C1');

  const opaque = {
    classes: ['new-comments'],
    from: { conversationComments: 1 },
    to: { conversationComments: 2, recentComments: [{ id: 'C2' }] },
  };
  enrichEmittedDeltas([opaque], ['comments'], { fetch: () => calls.push('must not fetch') });
  assert.deepEqual(calls, [{ kind: 'comments', ids: ['C1'] }]);
  assert.equal(opaque.enrichment, undefined);
});

test('selected kinds with no final matching class make no calls, while a failed sibling does not remove successful enrichment', () => {
  let calls = 0;
  const ignored = { classes: ['updated'], from: {}, to: {} };
  const ignoredResult = enrichEmittedDeltas([ignored], ['review', 'comments', 'threads'], {
    fetch: () => calls++,
  });
  assert.deepEqual(ignoredResult.warnings, []);
  assert.equal(ignoredResult.rateLimit, null);
  assert.equal(calls, 0);

  const delta = {
    classes: ['review-changed', 'new-comments'],
    from: { reviews: [], conversationComments: 0, recentComments: [] },
    to: {
      reviews: [{ id: 'R1', state: 'changes_requested' }],
      conversationComments: 1,
      recentComments: [{ id: 'C1' }],
    },
  };
  const { warnings } = enrichEmittedDeltas([delta], ['review', 'comments'], {
    fetch: (kind) => {
      if (kind === 'review') throw new Error('unavailable');
      return { rows: [{ id: 'C1', author: null, createdAt: 'now', body: '' }], rateLimit: null };
    },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(delta.enrichment), ['comments']);
});

test('thread-replies fetches exactly the threads whose count rose, with per-thread increment', () => {
  const delta = {
    classes: ['review-comments-added'],
    from: {
      threads: [
        { id: 'T1', resolved: false, comments: 1 },
        { id: 'T2', resolved: false, comments: 3 },
      ],
    },
    to: {
      threads: [
        { id: 'T1', resolved: false, comments: 3 },
        { id: 'T2', resolved: false, comments: 3 },
      ],
    },
  };
  const calls = [];
  const { warnings } = enrichEmittedDeltas([delta], ['thread-replies'], {
    fetch: (kind, ids) => {
      calls.push({ kind, ids });
      return {
        rows: [{ id: 'T1', replies: [{ id: 'C1', author: 'bob', createdAt: 'now', body: 'x' }] }],
        rateLimit: null,
      };
    },
  });
  assert.deepEqual(calls, [
    { kind: 'thread-replies', ids: [{ id: 'T1', increment: 2, total: 3 }] },
  ]);
  assert.equal(warnings.length, 0);
  assert.deepEqual(delta.enrichment['thread-replies'], [
    { id: 'T1', replies: [{ id: 'C1', author: 'bob', createdAt: 'now', body: 'x' }] },
  ]);
});

test('thread-replies with no attributable increment is an opaque-identity warning', () => {
  const delta = {
    classes: ['review-comments-added'],
    from: { threads: [{ id: 'T3', resolved: false, comments: 5 }] },
    to: { threads: [{ id: 'T3', resolved: false, comments: 5 }] },
  };
  const { warnings } = enrichEmittedDeltas([delta], ['thread-replies'], {
    fetch: () => {
      throw new Error('must not call');
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal(delta.enrichment, undefined);
});

test('extractMentions ignores email domains and deduplicates case-insensitively', () => {
  assert.deepEqual(extractMentions('a@b.com @One @one @org/team'), ['One', 'org/team']);
});

test('body enrichment fetches a new issue by its own node id and attaches mentions', () => {
  const delta = {
    entity: 'issue',
    classes: ['new'],
    context: { id: 'I_1' },
    from: null,
    to: {},
  };
  const calls = [];
  const { warnings, rateLimit } = enrichEmittedDeltas([delta], ['body'], {
    fetch: (kind, ids) => {
      calls.push({ kind, ids });
      return {
        rows: [{ id: 'I_1', body: 'please review @alice' }],
        rateLimit: { cost: 1, remaining: 99, resetAt: '2026-07-01T13:00:00.000Z' },
      };
    },
  });
  assert.deepEqual(calls, [{ kind: 'body', ids: ['I_1'] }]);
  assert.deepEqual(delta.enrichment.body, { body: 'please review @alice', mentions: ['alice'] });
  assert.equal(warnings.length, 0);
  assert.deepEqual(rateLimit, { cost: 1, remaining: 99, resetAt: '2026-07-01T13:00:00.000Z' });
});

test('body enrichment applies to first-seen, reopened, and baseline-state, never to plain updated', () => {
  for (const classes of [['first-seen'], ['reopened'], ['baseline-state']]) {
    const delta = { entity: 'pr', classes, context: { id: 'PR_1' }, from: null, to: {} };
    let calls = 0;
    enrichEmittedDeltas([delta], ['body'], {
      fetch: () => {
        calls++;
        return { rows: [{ id: 'PR_1', body: 'x' }], rateLimit: null };
      },
    });
    assert.equal(calls, 1, `expected a body fetch for classes ${classes.join(',')}`);
  }

  const updated = {
    entity: 'pr',
    classes: ['updated'],
    context: { id: 'PR_2' },
    from: {},
    to: {},
  };
  let updatedCalls = 0;
  const { warnings } = enrichEmittedDeltas([updated], ['body'], {
    fetch: () => updatedCalls++,
  });
  assert.equal(updatedCalls, 0);
  assert.equal(warnings.length, 0, 'plain updated is out of scope, not an opaque-identity warning');
  assert.equal(updated.enrichment, undefined);
});

test('body enrichment makes zero calls for a new-comments-only delta', () => {
  const delta = {
    entity: 'pr',
    classes: ['new-comments'],
    context: { id: 'PR_3' },
    from: { conversationComments: 1 },
    to: { conversationComments: 2 },
  };
  let calls = 0;
  const { warnings } = enrichEmittedDeltas([delta], ['body'], { fetch: () => calls++ });
  assert.equal(calls, 0);
  assert.equal(warnings.length, 0);
  assert.equal(delta.enrichment, undefined);
});
