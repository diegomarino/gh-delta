import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichEmittedDeltas, extractMentions } from '../lib/enrich.mjs';

test('enrichment uses final delta identities, keeps successful siblings, and preserves mention order', () => {
  const delta = {
    classes: ['review-changed', 'new-comments', 'unresolved-threads-added'],
    from: {
      reviewDetails: [{ id: 'R1', state: 'CHANGES_REQUESTED', submittedAt: 'old', commit: 'a' }],
      conversationComments: 1,
      commentNodes: [{ id: 'C1', author: 'old' }],
      threadStates: [{ id: 'T1', isResolved: true }],
    },
    to: {
      reviewDetails: [{ id: 'R1', state: 'CHANGES_REQUESTED', submittedAt: 'new', commit: 'b' }],
      conversationComments: 2,
      commentNodes: [
        { id: 'C1', author: 'old' },
        { id: 'C2', author: 'new' },
      ],
      threadStates: [{ id: 'T1', isResolved: false }],
    },
  };
  const calls = [];
  const warnings = enrichEmittedDeltas([delta], ['review', 'comments', 'threads'], {
    fetch(kind, ids) {
      calls.push({ kind, ids });
      if (kind === 'review')
        return [
          {
            id: 'R1',
            author: 'a',
            state: 'CHANGES_REQUESTED',
            submittedAt: 'new',
            commit: 'b',
            body: 'fix',
          },
        ];
      if (kind === 'comments')
        return [
          {
            id: 'C2',
            author: 'b',
            createdAt: 'now',
            body: 'hi @Alice and @org/team, x@y.com @alice',
          },
        ];
      return [
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
      ];
    },
  });
  assert.deepEqual(calls, [
    { kind: 'review', ids: ['R1'] },
    { kind: 'comments', ids: ['C2'] },
    { kind: 'threads', ids: ['T1'] },
  ]);
  assert.deepEqual(delta.enrichment.comments[0].mentions, ['Alice', 'org/team']);
  assert.equal(warnings.length, 0);
});

test('enrichment skips opaque identities and turns one boundary failure into a warning', () => {
  const delta = { classes: ['new-comments'], from: { comments: 1 }, to: { comments: 2 } };
  let calls = 0;
  const warnings = enrichEmittedDeltas([delta], ['comments'], { fetch: () => calls++ });
  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(delta.enrichment, undefined);

  const good = {
    classes: ['new-comments'],
    from: { conversationComments: 1, commentNodes: [{ id: 'C1' }] },
    to: { conversationComments: 2, commentNodes: [{ id: 'C1' }, { id: 'C2' }] },
  };
  const failure = enrichEmittedDeltas([good], ['comments'], {
    fetch: () => {
      throw new Error('nope');
    },
  });
  assert.equal(failure.length, 1);
  assert.equal(good.enrichment, undefined);
});

test('a zero-count prior comment fingerprint may use an absent identity window as empty', () => {
  const delta = {
    classes: ['new-comments'],
    from: { conversationComments: 0 },
    to: { conversationComments: 1, commentNodes: [{ id: 'C1' }] },
  };
  const calls = [];
  const warnings = enrichEmittedDeltas([delta], ['comments'], {
    fetch: (kind, ids) => {
      calls.push({ kind, ids });
      return [{ id: 'C1', author: 'a', createdAt: 'now', body: 'body' }];
    },
  });
  assert.deepEqual(calls, [{ kind: 'comments', ids: ['C1'] }]);
  assert.equal(warnings.length, 0);
  assert.equal(delta.enrichment.comments[0].id, 'C1');

  const opaque = {
    classes: ['new-comments'],
    from: { conversationComments: 1 },
    to: { conversationComments: 2, commentNodes: [{ id: 'C2' }] },
  };
  enrichEmittedDeltas([opaque], ['comments'], { fetch: () => calls.push('must not fetch') });
  assert.deepEqual(calls, [{ kind: 'comments', ids: ['C1'] }]);
  assert.equal(opaque.enrichment, undefined);
});

test('selected kinds with no final matching class make no calls, while a failed sibling does not remove successful enrichment', () => {
  let calls = 0;
  const ignored = { classes: ['updated'], from: {}, to: {} };
  assert.deepEqual(
    enrichEmittedDeltas([ignored], ['review', 'comments', 'threads'], {
      fetch: () => calls++,
    }),
    [],
  );
  assert.equal(calls, 0);

  const delta = {
    classes: ['review-changed', 'new-comments'],
    from: { reviewDetails: [], conversationComments: 0, commentNodes: [] },
    to: {
      reviewDetails: [{ id: 'R1', state: 'CHANGES_REQUESTED' }],
      conversationComments: 1,
      commentNodes: [{ id: 'C1' }],
    },
  };
  const warnings = enrichEmittedDeltas([delta], ['review', 'comments'], {
    fetch: (kind) => {
      if (kind === 'review') throw new Error('unavailable');
      return [{ id: 'C1', author: null, createdAt: 'now', body: '' }];
    },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(delta.enrichment), ['comments']);
});

test('extractMentions ignores email domains and deduplicates case-insensitively', () => {
  assert.deepEqual(extractMentions('a@b.com @One @one @org/team'), ['One', 'org/team']);
});
