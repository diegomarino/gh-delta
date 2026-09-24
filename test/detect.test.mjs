// Pure detector tests: each case protects one semantic delta class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltas, threadReplyIncrements } from '../lib/detect.mjs';
import { enrichDelta } from '../lib/cli.mjs';
import {
  DELTA_CLASSES,
  DELTA_DETAIL_FIELDS,
  DELTA_DETAIL_FIELDS_BY_CLASS,
} from '../lib/contract.mjs';

const AT = '2026-07-01T10:00:00Z';

// These objects are the normalized shape lib/gh.mjs's normalizePr/normalizeIssue
// produce -- lowercase enums, checks/reviews/threads rows -- not raw GraphQL.
const pr = (over = {}) => ({
  number: 42,
  title: 'add widget',
  state: 'open',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
  reviewDecision: 'review_required',
  reviews: [],
  mergeable: 'unknown',
  conversationComments: 0,
  reviewComments: 0,
  threads: [],
  headSha: 'sha1',
  ...over,
});

const thread = (id, resolved) => ({ id, resolved });

test('first run establishes a baseline with no deltas', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  assert.equal(r.baseline, true);
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
});

test('a snapshot item carries fingerprint, context, and meta', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const item = r.snapshot.pr['42'];
  assert.deepEqual(Object.keys(item).sort(), ['context', 'fingerprint', 'meta']);
  assert.equal(item.fingerprint.state, 'open');
  assert.deepEqual(item.context, {
    id: null,
    title: 'add widget',
    url: null,
    author: null,
    createdAt: null,
    headRefName: null,
  });
  assert.equal(item.meta.missingTicks, 0);
  assert.equal(item.meta.seenAt, AT);
  assert.equal(item.meta.changedAt, AT);
  assert.equal(item.meta.ticksSinceChange, 0);
});

test('a delta`s from/to are full snapshot items, not bare fingerprints', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  const delta = r.deltas[0];
  assert.deepEqual(Object.keys(delta.from).sort(), ['context', 'fingerprint', 'meta']);
  assert.deepEqual(Object.keys(delta.to).sort(), ['context', 'fingerprint', 'meta']);
});

test('a mergeStateStatus-only transition (clean->behind) emits an updated delta', () => {
  // The P1 scenario: base branch advances, PR goes clean->behind with no other
  // change (still open, still mergeable, same head/updatedAt). It must surface, or
  // a consumer stays at a stale "ready to merge".
  const base = detectDeltas(
    null,
    { pr: [pr({ mergeStateStatus: 'clean' })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeStateStatus: 'behind' })], issue: [] },
    { at: AT },
  );
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['updated']);
  assert.equal(r.deltas[0].to.fingerprint.mergeStateStatus, 'behind');
});

test('an unchanged mergeStateStatus does not emit a delta', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ mergeStateStatus: 'clean' })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeStateStatus: 'clean' })], issue: [] },
    { at: AT },
  );
  assert.deepEqual(r.deltas, []);
});

test('baseline-state is a registered closed-set class with a detail field map', () => {
  assert.ok(DELTA_CLASSES.includes('baseline-state'));
  assert.deepEqual(DELTA_DETAIL_FIELDS_BY_CLASS['baseline-state'], ['presence', 'state']);
});

test('baseline with emitBaselineState off stays empty (byte-identical default)', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  assert.equal(r.baseline, true);
  assert.deepEqual(r.deltas, []);
});

test('baseline with emitBaselineState on emits one baseline-state delta per open item', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] }, { emitBaselineState: true, at: AT });
  assert.equal(r.baseline, true);
  assert.equal(r.deltas.length, 1);
  const d = r.deltas[0];
  assert.deepEqual(d.classes, ['baseline-state']);
  assert.equal(d.from, null);
  assert.equal(d.to.fingerprint.state, 'open');
  assert.equal(d.entity, 'pr');
  assert.equal(d.number, 42);
});

test('baseline-state covers both PR and issue open items within entities', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    conversationComments: 0,
  };
  const r = detectDeltas(null, { pr: [pr()], issue: [issue] }, { emitBaselineState: true, at: AT });
  const entities = r.deltas.map((d) => d.entity).sort();
  assert.deepEqual(entities, ['issue', 'pr']);
  assert.ok(r.deltas.every((d) => d.classes[0] === 'baseline-state'));
});

test('emitBaselineState is inert on a non-baseline run', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr()], issue: [] },
    { emitBaselineState: true, at: AT },
  );
  assert.equal(r.baseline, false);
  assert.deepEqual(r.deltas, []);
});

test('a brand-new PR after baseline emits `new`', () => {
  const base = detectDeltas(null, { pr: [], issue: [] }, { at: AT });
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] }, { at: AT });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['new']);
});

test('a first-observed closed PR emits first-seen instead of new', () => {
  const base = detectDeltas(null, { pr: [], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ state: 'merged', updatedAt: '2026-07-01T09:00:00Z' })], issue: [] },
    { at: AT },
  );
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['first-seen']);
});

test('open → merged emits `merged`, not `closed`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ state: 'merged', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('merged'));
  assert.ok(!r.deltas[0].classes.includes('closed'));
});

test('CI failure → success + review approved emits ci-changed + review-changed', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          updatedAt: '2026-07-01T11:00:00Z',
          checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
          reviewDecision: 'approved',
          reviews: [
            { id: 'PRR_1', author: 'alice', state: 'approved', submittedAt: '', commit: '' },
          ],
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('ci-changed'));
  assert.ok(r.deltas[0].classes.includes('review-changed'));
});

test('mergeable unknown → mergeable does NOT emit became-mergeable', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'unknown' })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeable: 'mergeable', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(!r.deltas[0]?.classes.includes('became-mergeable'));
});

test('mergeable conflicting → mergeable emits became-mergeable', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ mergeable: 'conflicting' })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeable: 'mergeable', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('became-mergeable'));
});

test('an identical PR (only array reorder) emits NO delta', () => {
  const base = detectDeltas(
    null,
    {
      pr: [
        pr({
          checks: [
            { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
            { name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' },
          ],
        }),
      ],
      issue: [],
    },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          checks: [
            { name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' },
            { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
          ],
        }),
      ],
      issue: [],
    },
    { at: AT },
  );
  assert.deepEqual(r.deltas, []);
});

test('ready → draft emits converted-to-draft', () => {
  const base = detectDeltas(null, { pr: [pr({ isDraft: false })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ isDraft: true, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('converted-to-draft'));
});

test('mergeable mergeable → conflicting emits became-conflicting', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'mergeable' })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeable: 'conflicting', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('became-conflicting'));
});

test('mergeable unknown → conflicting does NOT emit became-conflicting', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'unknown' })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ mergeable: 'conflicting', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(!r.deltas[0]?.classes.includes('became-conflicting'));
});

test('a base branch change emits base-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ baseRef: 'main' })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ baseRef: 'release/2.0', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('base-changed'));
});

test('a PR label change emits relabeled', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ labels: [{ name: 'bug' }] })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({ labels: [{ name: 'bug' }, { name: 'urgent' }], updatedAt: '2026-07-01T11:00:00Z' }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('relabeled'));
});

test('a PR assignee change emits assignees-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ assignees: ['alice'] })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ assignees: ['alice', 'bob'], updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('assignees-changed'));
});

test('an issue assignee change emits assignees-changed', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    assignees: ['alice'],
    conversationComments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [], issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', assignees: [] }] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('assignees-changed'));
});

test('a review request emits review-requests-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ reviewRequests: [] })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ reviewRequests: ['carol'], updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('review-requests-changed'));
});

test('a comment total decrease emits comments-removed', () => {
  const base = detectDeltas(null, { pr: [pr({ conversationComments: 3 })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ conversationComments: 2, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['comments-removed']);
});

test('a reply in an existing thread is review-comments-added, not new-comments', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ reviewComments: 0, conversationComments: 0 })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [pr({ reviewComments: 1, conversationComments: 0, updatedAt: '2026-07-01T11:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['review-comments-added']);
});

test('a conversation comment is new-comments only, no review-comments-*', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ reviewComments: 0, conversationComments: 0 })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [pr({ reviewComments: 0, conversationComments: 1, updatedAt: '2026-07-01T11:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('a thread-comment count drop is review-comments-removed', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ reviewComments: 2, conversationComments: 0 })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [pr({ reviewComments: 1, conversationComments: 0, updatedAt: '2026-07-01T11:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['review-comments-removed']);
});

test('issue comment-count changes still classify off conversationComments alone', () => {
  const issue = {
    number: 1,
    title: 't',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    conversationComments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [], issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', conversationComments: 1 }] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('threadReplyIncrements only reports threads present in both sides, with a positive delta', () => {
  const oldThreads = [
    { id: 'T1', resolved: false, comments: 1 },
    { id: 'T2', resolved: false, comments: 3 },
  ];
  const newThreads = [
    { id: 'T1', resolved: false, comments: 3 }, // +2
    { id: 'T2', resolved: false, comments: 3 }, // unchanged
    { id: 'T3', resolved: false, comments: 5 }, // brand new thread, no prior baseline: excluded
  ];
  assert.deepEqual(threadReplyIncrements(oldThreads, newThreads), [{ id: 'T1', increment: 2 }]);
});

test('threadReplyIncrements returns [] for no threads or no increments', () => {
  assert.deepEqual(threadReplyIncrements([], []), []);
  assert.deepEqual(threadReplyIncrements(undefined, undefined), []);
  assert.deepEqual(
    threadReplyIncrements([{ id: 'T1', comments: 2 }], [{ id: 'T1', comments: 2 }]),
    [],
  );
});

test('draft → ready emits draft-ready', () => {
  const base = detectDeltas(null, { pr: [pr({ isDraft: true })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ isDraft: false, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('draft-ready'));
});

test('new unresolved review threads emit unresolved-threads-added', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T0', true)] })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          threads: [thread('T0', true), thread('T1', false)],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-added'));
});

test('resolved review threads emit unresolved-threads-resolved', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T0', false), thread('T1', false)] })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          threads: [thread('T0', true), thread('T1', true)],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('review thread total changes emit review-threads-changed when unresolved count is stable', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T0', false)] })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          threads: [thread('T0', false), thread('T1', true)],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['review-threads-changed']);
});

test('a push changes the head SHA, emitting head-changed alongside updated', () => {
  const base = detectDeltas(null, { pr: [pr({ headSha: 'sha1' })], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ headSha: 'sha2', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  const delta = r.deltas[0];
  assert.deepEqual(delta.classes.sort(), ['head-changed', 'updated']);
  assert.equal(delta.from.fingerprint.headSha, 'sha1');
  assert.equal(delta.to.fingerprint.headSha, 'sha2');
});

test('a head SHA change alongside another specific class still carries head-changed', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ headSha: 'sha1', mergeable: 'conflicting' })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [pr({ headSha: 'sha2', mergeable: 'mergeable', updatedAt: '2026-07-01T11:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  const delta = r.deltas[0];
  assert.ok(delta.classes.includes('head-changed'));
  assert.ok(delta.classes.includes('became-mergeable'));
});

// --- Review-thread IDENTITY, not just counters (headline regression) -------
//
// R2 dropped the reviewThreads/unresolvedReviewThreads integer counters:
// `threads` (a sorted `{id, resolved}` list, part of `fingerprint` like every
// other compared field) is the sole source of truth, and both the totals and
// the identity swap below are derived from it. If one thread is resolved and
// a different one reopens in the same tick, the totals are unchanged and a
// counter-only comparison would emit nothing; thread-identity comparison is
// what catches this.

test('one thread resolved and another reopened with totals unchanged still emits a delta naming both threads', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T_A', false), thread('T_B', true)] })], issue: [] },
    { at: AT },
  );
  // Swap: A resolves, B reopens. Same total (2), same unresolved count (1), and
  // even the same updatedAt -- every field a counter-only comparison looks at
  // is identical. Only thread identity moved, and that alone must still be
  // enough to trigger the delta.
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ threads: [thread('T_A', true), thread('T_B', false)] })], issue: [] },
    { at: AT },
  );
  assert.equal(r.deltas.length, 1, 'the swap must still be observed as a delta');
  const delta = r.deltas[0];
  assert.ok(delta.classes.includes('unresolved-threads-added'), 'T_B newly unresolved');
  assert.ok(delta.classes.includes('unresolved-threads-resolved'), 'T_A newly resolved');
  // Both thread ids are recoverable from the delta's from/to thread states.
  const oldStates = new Map(delta.from.fingerprint.threads.map((t) => [t.id, t.resolved]));
  const newlyUnresolved = delta.to.fingerprint.threads
    .filter((t) => !t.resolved && oldStates.get(t.id) !== false)
    .map((t) => t.id);
  const newlyResolved = delta.to.fingerprint.threads
    .filter((t) => t.resolved && oldStates.get(t.id) === false)
    .map((t) => t.id);
  assert.deepEqual(newlyUnresolved, ['T_B']);
  assert.deepEqual(newlyResolved, ['T_A']);
});

test('a genuinely new unresolved thread (identity-based) still emits unresolved-threads-added', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T_A', true)] })], issue: [] },
    { at: AT },
  );
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [
        pr({
          threads: [thread('T_A', true), thread('T_B', false)],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-added'));
  assert.ok(!r.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('issue label removal emits relabeled', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    conversationComments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    {
      pr: [],
      issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', labels: [{ name: 'backend' }] }],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.deltas[0].classes.includes('relabeled'));
});

test('a bare updatedAt bump with no specific signal emits `updated`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['updated']);
});

test('omitted entity collection preserves that side of the snapshot', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    conversationComments: 0,
  };
  const base = detectDeltas(null, { pr: [pr()], issue: [issue] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.ok(r.snapshot.issue['7']);
  assert.ok(!r.deltas.some((d) => d.entity === 'issue'));
});

test('objects missing from a fetched collection emit missing and are retained', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].entity, 'pr');
  assert.deepEqual(r.deltas[0].classes, ['missing']);
  assert.equal(r.deltas[0].missingTicks, 1);
  assert.equal(r.deltas[0].to, null);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].meta.missingTicks, 1);
  assert.equal('missing' in r.snapshot.pr['42'], false);
});

test('objects still missing emit still-missing after the first missing tick', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  const still = detectDeltas(missing.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(still.deltas[0].classes, ['still-missing']);
  assert.equal(still.deltas[0].missingTicks, 2);
});

test('a missing object that reappears unchanged emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  const back = detectDeltas(missing.snapshot, { pr: [pr()], issue: [] }, { at: AT });

  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.deltas[0].from.meta.missingTicks, 1);
  assert.equal(back.deltas[0].to.meta.missingTicks, 0);
  assert.equal(back.snapshot.pr['42'].meta.missingTicks, 0);
});

test('a missing object that reappears changed emits reappeared plus specific classes', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  const back = detectDeltas(
    missing.snapshot,
    { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z', conversationComments: 1 })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );

  assert.ok(back.deltas[0].classes.includes('reappeared'));
  assert.ok(back.deltas[0].classes.includes('new-comments'));
});

test('a PR that goes missing and reappears after a same-count thread swap emits unresolved-threads-added/-resolved, not just updated', () => {
  const base = detectDeltas(
    null,
    { pr: [pr({ threads: [thread('T_A', false), thread('T_B', true)] })], issue: [] },
    { at: AT },
  );
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(missing.deltas[0].classes, ['missing']);
  const back = detectDeltas(
    missing.snapshot,
    { pr: [pr({ threads: [thread('T_A', true), thread('T_B', false)] })], issue: [] },
    { at: AT },
  );
  const delta = back.deltas[0];
  assert.ok(delta.classes.includes('reappeared'));
  assert.ok(delta.classes.includes('unresolved-threads-added'), 'T_B newly unresolved');
  assert.ok(delta.classes.includes('unresolved-threads-resolved'), 'T_A newly resolved');
  assert.ok(
    !delta.classes.includes('updated'),
    'thread-identity classes fully explain the change; must not also fall back to updated',
  );
});

test('an exact comment total increase emits new-comments', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'open',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    conversationComments: 130,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] }, { at: AT });
  const r = detectDeltas(
    base.snapshot,
    { pr: [], issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', conversationComments: 131 }] },
    { at: '2026-07-01T11:00:00Z' },
  );
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('missing demotes to presumed-deleted on the third absent tick, then goes silent', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  const t1 = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(t1.deltas[0].classes, ['missing']);
  assert.equal(t1.snapshot.pr['42'].meta.missingTicks, 1);
  const t2 = detectDeltas(t1.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(t2.deltas[0].classes, ['still-missing']);
  assert.equal(t2.deltas[0].missingTicks, 2);
  const t3 = detectDeltas(t2.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(t3.deltas[0].classes, ['presumed-deleted']);
  assert.equal(t3.deltas[0].missingTicks, 3);
  const t4 = detectDeltas(t3.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(t4.deltas, []);
  assert.equal(t4.snapshot.pr['42'].meta.missingTicks, 4); // memory intact
});

test('an archived (presumed-deleted) object that reappears emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] }, { at: AT });
  let s = base.snapshot;
  for (let i = 0; i < 4; i++) s = detectDeltas(s, { pr: [], issue: [] }, { at: AT }).snapshot;
  const back = detectDeltas(s, { pr: [pr()], issue: [] }, { at: AT });
  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.snapshot.pr['42'].meta.missingTicks, 0);
});

test('absent closed items are dormant memory, not missing (incremental scope)', () => {
  const base = detectDeltas(null, { pr: [pr({ state: 'merged' })], issue: [] }, { at: AT });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] }, { at: AT });
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].meta.missingTicks, 0);
});

// --- General contract guard (P2-2's general form) --------------------------
//
// Every `details` row's `field` must be declared in DELTA_DETAIL_FIELDS_BY_CLASS
// for its `class`, and every key on the row must be within DELTA_DETAIL_FIELDS.
// This exercises every class in DELTA_CLASSES so the next field added to a
// fingerprint without a matching contract entry fails here instead of leaking
// into a consumer that validates against the exported contract.

test('every emitted detail key is declared in the exported contract, across every delta class', () => {
  const deltas = [];

  // baseline-state
  const baselineRun = detectDeltas(
    null,
    { pr: [pr({ number: 1 })], issue: [] },
    { emitBaselineState: true, at: AT },
  );
  deltas.push(...baselineRun.deltas);

  // new / first-seen
  const seed = detectDeltas(null, { pr: [pr({ number: 1 })], issue: [] }, { at: AT });
  const withNew = detectDeltas(
    seed.snapshot,
    { pr: [pr({ number: 1 }), pr({ number: 2, state: 'open' })], issue: [] },
    { at: AT },
  );
  deltas.push(...withNew.deltas.filter((d) => d.number === 2));
  const withFirstSeen = detectDeltas(
    seed.snapshot,
    { pr: [pr({ number: 1 }), pr({ number: 3, state: 'merged' })], issue: [] },
    { at: AT },
  );
  deltas.push(...withFirstSeen.deltas.filter((d) => d.number === 3));

  // closed / reopened / merged
  const sOpen = detectDeltas(null, { pr: [pr({ number: 10 })], issue: [] }, { at: AT });
  const tClosed = detectDeltas(
    sOpen.snapshot,
    { pr: [pr({ number: 10, state: 'closed', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tClosed.deltas);
  const tReopened = detectDeltas(
    tClosed.snapshot,
    { pr: [pr({ number: 10, state: 'open', updatedAt: '2026-07-01T12:00:00Z' })], issue: [] },
    { at: '2026-07-01T12:00:00Z' },
  );
  deltas.push(...tReopened.deltas);
  const tMerged = detectDeltas(
    tReopened.snapshot,
    { pr: [pr({ number: 10, state: 'merged', updatedAt: '2026-07-01T13:00:00Z' })], issue: [] },
    { at: '2026-07-01T13:00:00Z' },
  );
  deltas.push(...tMerged.deltas);

  // missing / still-missing / presumed-deleted / reappeared
  const sM = detectDeltas(null, { pr: [pr({ number: 20 })], issue: [] }, { at: AT });
  const m1 = detectDeltas(sM.snapshot, { pr: [], issue: [] }, { at: AT });
  deltas.push(...m1.deltas);
  const m2 = detectDeltas(m1.snapshot, { pr: [], issue: [] }, { at: AT });
  deltas.push(...m2.deltas);
  const m3 = detectDeltas(m2.snapshot, { pr: [], issue: [] }, { at: AT });
  deltas.push(...m3.deltas);
  const back = detectDeltas(m3.snapshot, { pr: [pr({ number: 20 })], issue: [] }, { at: AT });
  deltas.push(...back.deltas);

  // new-comments / comments-removed
  const sC = detectDeltas(null, { pr: [pr({ number: 30, conversationComments: 3 })], issue: [] }, { at: AT });
  const tMore = detectDeltas(
    sC.snapshot,
    { pr: [pr({ number: 30, conversationComments: 5, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tMore.deltas);
  const tLess = detectDeltas(
    tMore.snapshot,
    { pr: [pr({ number: 30, conversationComments: 2, updatedAt: '2026-07-01T12:00:00Z' })], issue: [] },
    { at: '2026-07-01T12:00:00Z' },
  );
  deltas.push(...tLess.deltas);

  // updated (bare)
  const sU = detectDeltas(null, { pr: [pr({ number: 40 })], issue: [] }, { at: AT });
  const tU = detectDeltas(
    sU.snapshot,
    { pr: [pr({ number: 40, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tU.deltas);

  // draft-ready / converted-to-draft
  const sD = detectDeltas(null, { pr: [pr({ number: 50, isDraft: true })], issue: [] }, { at: AT });
  const tReady = detectDeltas(
    sD.snapshot,
    { pr: [pr({ number: 50, isDraft: false, updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tReady.deltas);
  const tDraft = detectDeltas(
    tReady.snapshot,
    { pr: [pr({ number: 50, isDraft: true, updatedAt: '2026-07-01T12:00:00Z' })], issue: [] },
    { at: '2026-07-01T12:00:00Z' },
  );
  deltas.push(...tDraft.deltas);

  // ci-changed
  const sCi = detectDeltas(
    null,
    {
      pr: [
        pr({
          number: 60,
          checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
        }),
      ],
      issue: [],
    },
    { at: AT },
  );
  const tCi = detectDeltas(
    sCi.snapshot,
    {
      pr: [
        pr({
          number: 60,
          checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tCi.deltas);

  // review-changed
  const sR = detectDeltas(
    null,
    { pr: [pr({ number: 70, reviewDecision: 'review_required', reviews: [] })], issue: [] },
    { at: AT },
  );
  const tR = detectDeltas(
    sR.snapshot,
    {
      pr: [
        pr({
          number: 70,
          reviewDecision: 'approved',
          reviews: [
            {
              id: 'PRR_1',
              author: 'alice',
              state: 'approved',
              submittedAt: '2026-07-01T10:30:00Z',
              commit: 'c1',
            },
          ],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tR.deltas);

  // became-mergeable / became-conflicting
  const sMg = detectDeltas(
    null,
    { pr: [pr({ number: 80, mergeable: 'conflicting' })], issue: [] },
    { at: AT },
  );
  const tMg = detectDeltas(
    sMg.snapshot,
    {
      pr: [pr({ number: 80, mergeable: 'mergeable', updatedAt: '2026-07-01T11:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tMg.deltas);
  const tCf = detectDeltas(
    tMg.snapshot,
    {
      pr: [pr({ number: 80, mergeable: 'conflicting', updatedAt: '2026-07-01T12:00:00Z' })],
      issue: [],
    },
    { at: '2026-07-01T12:00:00Z' },
  );
  deltas.push(...tCf.deltas);

  // head-changed (coexists with updated)
  const sH = detectDeltas(
    null,
    { pr: [pr({ number: 90, headSha: 'sha1' })], issue: [] },
    { at: AT },
  );
  const tH = detectDeltas(
    sH.snapshot,
    { pr: [pr({ number: 90, headSha: 'sha2', updatedAt: '2026-07-01T11:00:00Z' })], issue: [] },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tH.deltas);

  // stale (only under the explicit inactivity option)
  const sStale = detectDeltas(
    null,
    { pr: [pr({ number: 95 })], issue: [] },
    { at: '2026-07-01T00:00:00Z', staleAfterMs: 1 },
  );
  const tStale = detectDeltas(
    sStale.snapshot,
    { pr: [pr({ number: 95 })], issue: [] },
    { at: '2026-07-02T00:00:00Z', staleAfterMs: 1 },
  );
  deltas.push(...tStale.deltas);

  // unresolved-threads-added / unresolved-threads-resolved (same-count swap)
  const sT = detectDeltas(
    null,
    { pr: [pr({ number: 100, threads: [thread('A', false), thread('B', true)] })], issue: [] },
    { at: AT },
  );
  const tT = detectDeltas(
    sT.snapshot,
    { pr: [pr({ number: 100, threads: [thread('A', true), thread('B', false)] })], issue: [] },
    { at: AT },
  );
  deltas.push(...tT.deltas);

  // review-threads-changed (total moves, no identity added/resolved)
  const sRT = detectDeltas(
    null,
    { pr: [pr({ number: 101, threads: [thread('X', true)] })], issue: [] },
    { at: AT },
  );
  const tRT = detectDeltas(
    sRT.snapshot,
    {
      pr: [
        pr({
          number: 101,
          updatedAt: '2026-07-01T11:00:00Z',
          threads: [thread('X', true), thread('Y', true)],
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tRT.deltas);

  // relabeled / assignees-changed / review-requests-changed / base-changed
  const sL = detectDeltas(
    null,
    {
      pr: [
        pr({
          number: 110,
          baseRef: 'main',
          labels: [{ name: 'a' }],
          assignees: ['alice'],
          reviewRequests: [],
        }),
      ],
      issue: [],
    },
    { at: AT },
  );
  const tL = detectDeltas(
    sL.snapshot,
    {
      pr: [
        pr({
          number: 110,
          baseRef: 'dev',
          labels: [{ name: 'b' }],
          assignees: ['bob'],
          reviewRequests: ['carol'],
          updatedAt: '2026-07-01T11:00:00Z',
        }),
      ],
      issue: [],
    },
    { at: '2026-07-01T11:00:00Z' },
  );
  deltas.push(...tL.deltas);

  const seenClasses = new Set();
  const allowedTopLevel = new Set(DELTA_DETAIL_FIELDS);
  for (const delta of deltas) {
    for (const klass of delta.classes) seenClasses.add(klass);
    enrichDelta(delta, { details: true });
    for (const row of delta.details) {
      for (const key of Object.keys(row)) {
        assert.ok(allowedTopLevel.has(key), `detail key "${key}" is not in DELTA_DETAIL_FIELDS`);
      }
      const byClass = DELTA_DETAIL_FIELDS_BY_CLASS[row.class];
      assert.ok(byClass, `no field map for delta class "${row.class}"`);
      if (!['presence', 'unknown'].includes(row.field)) {
        assert.ok(
          byClass.includes(row.field),
          `field "${row.field}" not declared for class "${row.class}"`,
        );
      }
    }
  }

  // Coverage check: this battery must actually exercise every class the
  // contract declares, or the guard above is silently vacuous for whichever
  // class was missed.
  for (const klass of DELTA_CLASSES) {
    assert.ok(seenClasses.has(klass), `battery never produced class "${klass}"`);
  }
});
