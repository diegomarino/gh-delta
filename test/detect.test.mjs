// Pure detector tests: each case protects one semantic delta class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltas } from '../lib/detect.mjs';
import { enrichDelta } from '../lib/cli.mjs';
import {
  DELTA_CLASSES,
  DELTA_DETAIL_FIELDS,
  DELTA_DETAIL_FIELDS_BY_CLASS,
} from '../lib/contract.mjs';

const pr = (over = {}) => ({
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  totalCommentsCount: 0,
  reviewThreads: 0,
  unresolvedReviewThreads: 0,
  headRefOid: 'sha1',
  ...over,
});

test('first run establishes a baseline with no deltas', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] });
  assert.equal(r.baseline, true);
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
});

test('a mergeStateStatus-only transition (CLEAN->BEHIND) emits an updated delta', () => {
  // The P1 scenario: base branch advances, PR goes CLEAN->BEHIND with no other
  // change (still OPEN, still MERGEABLE, same head/updatedAt). It must surface, or
  // a consumer stays at a stale "ready to merge".
  const base = detectDeltas(null, { pr: [pr({ mergeStateStatus: 'CLEAN' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeStateStatus: 'BEHIND' })],
    issue: [],
  });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['updated']);
  assert.equal(r.deltas[0].to.mergeStateStatus, 'BEHIND');
});

test('an unchanged mergeStateStatus does not emit a delta', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeStateStatus: 'CLEAN' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeStateStatus: 'CLEAN' })],
    issue: [],
  });
  assert.deepEqual(r.deltas, []);
});

test('a snapshot predating mergeStateStatus does not burst on first observation', () => {
  // Upgrade case (Codex P1): an older stored fingerprint lacks the field. Its
  // first appearance must NOT be read as a change, or every open PR emits a
  // spurious `updated` on the first post-upgrade tick.
  const base = detectDeltas(null, { pr: [pr({ mergeStateStatus: 'CLEAN' })], issue: [] });
  const legacy = { ...base.snapshot };
  delete legacy.pr['42'].mergeStateStatus; // simulate a pre-field snapshot
  const r = detectDeltas(legacy, { pr: [pr({ mergeStateStatus: 'CLEAN' })], issue: [] });
  assert.deepEqual(r.deltas, []);
});

test('baseline-state is a registered closed-set class with a detail field map', () => {
  assert.ok(DELTA_CLASSES.includes('baseline-state'));
  assert.deepEqual(DELTA_DETAIL_FIELDS_BY_CLASS['baseline-state'], ['presence', 'state']);
});

test('baseline with emitBaselineState off stays empty (byte-identical default)', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] });
  assert.equal(r.baseline, true);
  assert.deepEqual(r.deltas, []);
});

test('baseline with emitBaselineState on emits one baseline-state delta per open item', () => {
  const r = detectDeltas(null, { pr: [pr()], issue: [] }, { emitBaselineState: true });
  assert.equal(r.baseline, true);
  assert.equal(r.deltas.length, 1);
  const d = r.deltas[0];
  assert.deepEqual(d.classes, ['baseline-state']);
  assert.equal(d.from, null);
  assert.equal(d.to.state, 'OPEN');
  assert.equal(d.entity, 'pr');
  assert.equal(d.number, 42);
});

test('baseline-state covers both PR and issue open items within entities', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: 0,
  };
  const r = detectDeltas(null, { pr: [pr()], issue: [issue] }, { emitBaselineState: true });
  const entities = r.deltas.map((d) => d.entity).sort();
  assert.deepEqual(entities, ['issue', 'pr']);
  assert.ok(r.deltas.every((d) => d.classes[0] === 'baseline-state'));
});

test('emitBaselineState is inert on a non-baseline run', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] }, { emitBaselineState: true });
  assert.equal(r.baseline, false);
  assert.deepEqual(r.deltas, []);
});

test('a brand-new PR after baseline emits `new`', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['new']);
});

test('a first-observed closed PR emits first-seen instead of new', () => {
  const base = detectDeltas(null, { pr: [], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ state: 'MERGED', updatedAt: '2026-07-01T09:00:00Z' })],
    issue: [],
  });
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(r.deltas[0].classes, ['first-seen']);
});

test('OPEN → MERGED emits `merged`, not `closed`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('merged'));
  assert.ok(!r.deltas[0].classes.includes('closed'));
});

test('CI FAILURE → SUCCESS + review APPROVED emits ci-changed + review-changed', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        updatedAt: '2026-07-01T11:00:00Z',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        reviewDecision: 'APPROVED',
        latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
      }),
    ],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('ci-changed'));
  assert.ok(r.deltas[0].classes.includes('review-changed'));
});

test('mergeable UNKNOWN → MERGEABLE does NOT emit became-mergeable', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'UNKNOWN' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(!r.deltas[0]?.classes.includes('became-mergeable'));
});

test('mergeable CONFLICTING → MERGEABLE emits became-mergeable', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'CONFLICTING' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('became-mergeable'));
});

test('an identical PR (only array reorder) emits NO delta', () => {
  const base = detectDeltas(null, {
    pr: [
      pr({
        statusCheckRollup: [
          { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    ],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        statusCheckRollup: [
          { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
    ],
    issue: [],
  });
  assert.deepEqual(r.deltas, []);
});

test('ready → draft emits converted-to-draft', () => {
  const base = detectDeltas(null, { pr: [pr({ isDraft: false })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ isDraft: true, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('converted-to-draft'));
});

test('mergeable MERGEABLE → CONFLICTING emits became-conflicting', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'MERGEABLE' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'CONFLICTING', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('became-conflicting'));
});

test('mergeable UNKNOWN → CONFLICTING does NOT emit became-conflicting', () => {
  const base = detectDeltas(null, { pr: [pr({ mergeable: 'UNKNOWN' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ mergeable: 'CONFLICTING', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(!r.deltas[0]?.classes.includes('became-conflicting'));
});

test('a base branch change emits base-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ baseRefName: 'main' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ baseRefName: 'release/2.0', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('base-changed'));
});

test('a PR label change emits relabeled', () => {
  const base = detectDeltas(null, { pr: [pr({ labels: [{ name: 'bug' }] })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ labels: [{ name: 'bug' }, { name: 'urgent' }], updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('relabeled'));
});

test('a PR assignee change emits assignees-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ assignees: ['alice'] })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ assignees: ['alice', 'bob'], updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('assignees-changed'));
});

test('an issue assignee change emits assignees-changed', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    assignees: ['alice'],
    comments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', assignees: [] }],
  });
  assert.ok(r.deltas[0].classes.includes('assignees-changed'));
});

test('a review request emits review-requests-changed', () => {
  const base = detectDeltas(null, { pr: [pr({ reviewRequests: [] })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewRequests: ['carol'], updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('review-requests-changed'));
});

test('a comment total decrease emits comments-removed', () => {
  const base = detectDeltas(null, { pr: [pr({ totalCommentsCount: 3 })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ totalCommentsCount: 2, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['comments-removed']);
});

test('a snapshot predating the new compared fields does not burst on first observation', () => {
  // Same upgrade rule as mergeStateStatus: the first appearance of base/labels/
  // assignees/reviewRequests in a fresh fingerprint is not a change.
  const base = detectDeltas(null, {
    pr: [pr({ baseRefName: 'main', labels: [{ name: 'bug' }], assignees: ['alice'] })],
    issue: [],
  });
  const legacy = { ...base.snapshot };
  for (const field of ['base', 'labels', 'assignees', 'reviewRequests']) {
    delete legacy.pr['42'][field];
  }
  const r = detectDeltas(legacy, {
    pr: [pr({ baseRefName: 'main', labels: [{ name: 'bug' }], assignees: ['alice'] })],
    issue: [],
  });
  assert.deepEqual(r.deltas, []);
});

test('a legacy snapshot with a real concurrent change does not misfire the new classes', () => {
  // When a pre-upgrade snapshot sees a genuine change (a new comment), the delta
  // must not also claim relabeled/assignees-changed/base-changed just because the
  // old fingerprint lacked those keys.
  const base = detectDeltas(null, {
    pr: [pr({ baseRefName: 'main', labels: [{ name: 'bug' }], assignees: ['alice'] })],
    issue: [],
  });
  const legacy = { ...base.snapshot };
  for (const field of ['base', 'labels', 'assignees', 'reviewRequests']) {
    delete legacy.pr['42'][field];
  }
  const r = detectDeltas(legacy, {
    pr: [
      pr({
        baseRefName: 'main',
        labels: [{ name: 'bug' }],
        assignees: ['alice'],
        totalCommentsCount: 1,
        updatedAt: '2026-07-01T11:00:00Z',
      }),
    ],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('draft → ready emits draft-ready', () => {
  const base = detectDeltas(null, { pr: [pr({ isDraft: true })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ isDraft: false, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('draft-ready'));
});

test('new unresolved review threads emit unresolved-threads-added', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 1, unresolvedReviewThreads: 0 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 1, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-added'));
});

test('resolved review threads emit unresolved-threads-resolved', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 2 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 0, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('review thread total changes emit review-threads-changed when unresolved count is stable', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 1, unresolvedReviewThreads: 1 })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 1, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['review-threads-changed']);
});

test('a push changes the head SHA, emitting head-changed alongside updated', () => {
  const base = detectDeltas(null, { pr: [pr({ headRefOid: 'sha1' })], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ headRefOid: 'sha2', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  const delta = r.deltas[0];
  assert.deepEqual(delta.classes.sort(), ['head-changed', 'updated']);
  assert.equal(delta.from.head, 'sha1');
  assert.equal(delta.to.head, 'sha2');
});

test('a head SHA change alongside another specific class still carries head-changed', () => {
  const base = detectDeltas(null, {
    pr: [pr({ headRefOid: 'sha1', mergeable: 'CONFLICTING' })],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ headRefOid: 'sha2', mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  const delta = r.deltas[0];
  assert.ok(delta.classes.includes('head-changed'));
  assert.ok(delta.classes.includes('became-mergeable'));
});

// --- Review-thread IDENTITY, not just counters (headline regression) -------
//
// reviewThreads/unresolvedReviewThreads are integer counters. If one thread is
// resolved and a different one reopens in the same tick, the totals are
// unchanged and the counter-only comparison emits nothing. threadStates (a
// sorted `{id, isResolved}` list, kept OUT of comparableFingerprint) and the
// threadDigest it drives are the additional trigger that catches this.

const thread = (id, isResolved) => ({ id, isResolved });

test('one thread resolved and another reopened with totals unchanged still emits a delta naming both threads', () => {
  const base = detectDeltas(null, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('T_A', false), thread('T_B', true)],
      }),
    ],
    issue: [],
  });
  // Swap: A resolves, B reopens. Same reviewThreads (2), same
  // unresolvedReviewThreads (1), and even the same updatedAt -- every field the
  // counter-only comparison looks at is identical. Only the thread-identity
  // digest moved, and that alone must still be enough to trigger the delta.
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('T_A', true), thread('T_B', false)],
      }),
    ],
    issue: [],
  });
  assert.equal(r.deltas.length, 1, 'the swap must still be observed as a delta');
  const delta = r.deltas[0];
  assert.ok(delta.classes.includes('unresolved-threads-added'), 'T_B newly unresolved');
  assert.ok(delta.classes.includes('unresolved-threads-resolved'), 'T_A newly resolved');
  // Both thread ids are recoverable from the delta's from/to thread states.
  const oldStates = new Map(delta.from.threadStates.map((t) => [t.id, t.isResolved]));
  const newlyUnresolved = delta.to.threadStates
    .filter((t) => !t.isResolved && oldStates.get(t.id) !== false)
    .map((t) => t.id);
  const newlyResolved = delta.to.threadStates
    .filter((t) => t.isResolved && oldStates.get(t.id) === false)
    .map((t) => t.id);
  assert.deepEqual(newlyUnresolved, ['T_B']);
  assert.deepEqual(newlyResolved, ['T_A']);
});

test('a same-count thread swap does NOT fire when threadStates is absent on either side (legacy safety)', () => {
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 2, unresolvedReviewThreads: 1 })], // no reviewThreadNodes
    issue: [],
  });
  // Simulate a pre-upgrade snapshot: threadDigest/threadStates are now always
  // emitted by prFingerprint, so strip them here to pin the legacy shape the
  // guard in fingerprintChanged/threadSetDiff must still handle safely.
  const legacyFp = { ...base.snapshot.pr['42'] };
  delete legacyFp.threadDigest;
  delete legacyFp.threadStates;
  const legacySnapshot = { ...base.snapshot, pr: { ...base.snapshot.pr, 42: legacyFp } };
  assert.ok(!('threadDigest' in legacySnapshot.pr['42']));
  const r = detectDeltas(legacySnapshot, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        updatedAt: base.snapshot.pr['42'].updatedAt, // nothing else changes either
        reviewThreadNodes: [thread('T_A', true), thread('T_B', false)],
      }),
    ],
    issue: [],
  });
  // The old side has no threadStates to diff against, and nothing else about
  // the fingerprint changed, so this must not manufacture a delta.
  assert.deepEqual(r.deltas, []);
});

test('a genuinely new unresolved thread (identity-based) still emits unresolved-threads-added', () => {
  const base = detectDeltas(null, {
    pr: [
      pr({
        reviewThreads: 1,
        unresolvedReviewThreads: 0,
        reviewThreadNodes: [thread('T_A', true)],
      }),
    ],
    issue: [],
  });
  const r = detectDeltas(base.snapshot, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        updatedAt: '2026-07-01T11:00:00Z',
        reviewThreadNodes: [thread('T_A', true), thread('T_B', false)],
      }),
    ],
    issue: [],
  });
  assert.ok(r.deltas[0].classes.includes('unresolved-threads-added'));
  assert.ok(!r.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('a legacy snapshot with no digest on the old side converges after one tick (no phantom delta)', () => {
  // Simulate a pre-upgrade snapshot: it was written before threadDigest/
  // threadStates existed, so it lacks both keys even though the current
  // fetch now carries thread data.
  const base = detectDeltas(null, {
    pr: [pr({ reviewThreads: 1, unresolvedReviewThreads: 1 })], // no reviewThreadNodes
    issue: [],
  });
  // prFingerprint now always emits threadDigest/threadStates, so strip them
  // to simulate a snapshot written before those keys existed.
  const legacyFp = { ...base.snapshot.pr['42'] };
  delete legacyFp.threadDigest;
  delete legacyFp.threadStates;
  const legacy = { ...base.snapshot, pr: { ...base.snapshot.pr, 42: legacyFp } };
  assert.ok(!('threadDigest' in legacy.pr['42']));

  const sameThreads = [thread('T_A', false)];
  const tick1 = detectDeltas(legacy, {
    pr: [
      pr({
        reviewThreads: 1,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: sameThreads,
      }),
    ],
    issue: [],
  });
  // First observation of the digest must not itself be read as a change.
  assert.deepEqual(tick1.deltas, []);
  assert.ok('threadDigest' in tick1.snapshot.pr['42']);

  // Tick 2: now both sides carry the digest, so a genuine swap is caught.
  const tick2 = detectDeltas(tick1.snapshot, {
    pr: [
      pr({
        reviewThreads: 1,
        unresolvedReviewThreads: 1,
        updatedAt: '2026-07-01T12:00:00Z',
        reviewThreadNodes: [thread('T_A', true), thread('T_B', false)],
      }),
    ],
    issue: [],
  });
  assert.ok(tick2.deltas[0].classes.includes('unresolved-threads-added'));
  assert.ok(tick2.deltas[0].classes.includes('unresolved-threads-resolved'));
});

test('issue label removal emits relabeled', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [{ name: 'worker' }, { name: 'backend' }],
    comments: 0,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', labels: [{ name: 'backend' }] }],
  });
  assert.ok(r.deltas[0].classes.includes('relabeled'));
});

test('a bare updatedAt bump with no specific signal emits `updated`', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, {
    pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  assert.deepEqual(r.deltas[0].classes, ['updated']);
});

test('legacy commentsOverflow fingerprints do not emit an upgrade-only delta', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  base.snapshot.pr['42'].commentsOverflow = false;
  const r = detectDeltas(base.snapshot, { pr: [pr()], issue: [] });
  assert.deepEqual(r.deltas, []);
});

test('omitted entity collection preserves that side of the snapshot', () => {
  const issue = {
    number: 7,
    title: 'bug',
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: 0,
  };
  const base = detectDeltas(null, { pr: [pr()], issue: [issue] });
  const r = detectDeltas(base.snapshot, { pr: [pr({ updatedAt: '2026-07-01T11:00:00Z' })] });
  assert.ok(r.snapshot.issue['7']);
  assert.ok(!r.deltas.some((d) => d.entity === 'issue'));
});

test('objects missing from a fetched collection emit missing and are retained', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].entity, 'pr');
  assert.deepEqual(r.deltas[0].classes, ['missing']);
  assert.equal(r.deltas[0].missingTicks, 1);
  assert.equal(r.deltas[0].to, null);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].missing, true);
});

test('objects still missing emit still-missing after the first missing tick', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const still = detectDeltas(missing.snapshot, { pr: [], issue: [] });
  assert.deepEqual(still.deltas[0].classes, ['still-missing']);
  assert.equal(still.deltas[0].missingTicks, 2);
});

test('a missing object that reappears unchanged emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const back = detectDeltas(missing.snapshot, { pr: [pr()], issue: [] });

  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.deltas[0].from.missing, true);
  assert.equal(back.deltas[0].to.missing, undefined);
  assert.equal(back.snapshot.pr['42'].missing, undefined);
});

test('a missing object that reappears changed emits reappeared plus specific classes', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  const back = detectDeltas(missing.snapshot, {
    pr: [
      pr({
        updatedAt: '2026-07-01T11:00:00Z',
        totalCommentsCount: 1,
      }),
    ],
    issue: [],
  });

  assert.ok(back.deltas[0].classes.includes('reappeared'));
  assert.ok(back.deltas[0].classes.includes('new-comments'));
});

test('a PR that goes missing and reappears after a same-count thread swap emits unresolved-threads-added/-resolved, not just updated', () => {
  // P2-3 regression: the reappearance branch used to classify against
  // comparableFingerprint(oldFp), which strips threadStates -- so by the time
  // classifyPr ran, the old thread identities were gone and a same-count swap
  // during the missing window fell back to the generic `updated` catch-all.
  const base = detectDeltas(null, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('T_A', false), thread('T_B', true)],
      }),
    ],
    issue: [],
  });
  const missing = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(missing.deltas[0].classes, ['missing']);
  const back = detectDeltas(missing.snapshot, {
    pr: [
      pr({
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('T_A', true), thread('T_B', false)],
      }),
    ],
    issue: [],
  });
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
    state: 'OPEN',
    updatedAt: '2026-07-01T10:00:00Z',
    labels: [],
    comments: 130,
  };
  const base = detectDeltas(null, { pr: [], issue: [issue] });
  const r = detectDeltas(base.snapshot, {
    pr: [],
    issue: [{ ...issue, updatedAt: '2026-07-01T11:00:00Z', comments: 131 }],
  });
  assert.deepEqual(r.deltas[0].classes, ['new-comments']);
});

test('missing demotes to presumed-deleted on the third absent tick, then goes silent', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const t1 = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t1.deltas[0].classes, ['missing']);
  assert.equal(t1.snapshot.pr['42'].missingTicks, 1);
  const t2 = detectDeltas(t1.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t2.deltas[0].classes, ['still-missing']);
  assert.equal(t2.deltas[0].missingTicks, 2);
  const t3 = detectDeltas(t2.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t3.deltas[0].classes, ['presumed-deleted']);
  assert.equal(t3.deltas[0].missingTicks, 3);
  const t4 = detectDeltas(t3.snapshot, { pr: [], issue: [] });
  assert.deepEqual(t4.deltas, []);
  assert.equal(t4.snapshot.pr['42'].missing, true); // memory intact
});

test('an archived (presumed-deleted) object that reappears emits reappeared', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  let s = base.snapshot;
  for (let i = 0; i < 4; i++) s = detectDeltas(s, { pr: [], issue: [] }).snapshot;
  const back = detectDeltas(s, { pr: [pr()], issue: [] });
  assert.deepEqual(back.deltas[0].classes, ['reappeared']);
  assert.equal(back.snapshot.pr['42'].missingTicks, undefined);
});

test('absent closed items are dormant memory, not missing (incremental scope)', () => {
  const base = detectDeltas(null, { pr: [pr({ state: 'MERGED' })], issue: [] });
  const r = detectDeltas(base.snapshot, { pr: [], issue: [] });
  assert.deepEqual(r.deltas, []);
  assert.ok(r.snapshot.pr['42']);
  assert.equal(r.snapshot.pr['42'].missing, undefined);
});

test('legacy missing fingerprints without missingTicks continue the lifecycle', () => {
  const base = detectDeltas(null, { pr: [pr()], issue: [] });
  const legacy = detectDeltas(base.snapshot, { pr: [], issue: [] }).snapshot;
  delete legacy.pr['42'].missingTicks;
  const r = detectDeltas(legacy, { pr: [], issue: [] });
  assert.deepEqual(r.deltas[0].classes, ['still-missing']);
});

// --- General contract guard (P2-2's general form) --------------------------
//
// Every `details` row's `field` must be declared in DELTA_DETAIL_FIELDS_BY_CLASS
// for its `class`, and every key on the row must be within DELTA_DETAIL_FIELDS.
// This is the general version of the threadDigest/threadStates leak (P2-2):
// it exercises every class in DELTA_CLASSES so the next field added to a
// fingerprint without a matching contract entry fails here instead of leaking
// into a consumer that validates against the exported contract.

test('every emitted detail key is declared in the exported contract, across every delta class', () => {
  const deltas = [];

  // baseline-state
  const baselineRun = detectDeltas(
    null,
    { pr: [pr({ number: 1 })], issue: [] },
    { emitBaselineState: true },
  );
  deltas.push(...baselineRun.deltas);

  // new / first-seen
  const seed = detectDeltas(null, { pr: [pr({ number: 1 })], issue: [] });
  const withNew = detectDeltas(seed.snapshot, {
    pr: [pr({ number: 1 }), pr({ number: 2, state: 'OPEN' })],
    issue: [],
  });
  deltas.push(...withNew.deltas.filter((d) => d.number === 2));
  const withFirstSeen = detectDeltas(seed.snapshot, {
    pr: [pr({ number: 1 }), pr({ number: 3, state: 'MERGED' })],
    issue: [],
  });
  deltas.push(...withFirstSeen.deltas.filter((d) => d.number === 3));

  // closed / reopened / merged
  const sOpen = detectDeltas(null, { pr: [pr({ number: 10 })], issue: [] });
  const tClosed = detectDeltas(sOpen.snapshot, {
    pr: [pr({ number: 10, state: 'CLOSED', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  deltas.push(...tClosed.deltas);
  const tReopened = detectDeltas(tClosed.snapshot, {
    pr: [pr({ number: 10, state: 'OPEN', updatedAt: '2026-07-01T12:00:00Z' })],
    issue: [],
  });
  deltas.push(...tReopened.deltas);
  const tMerged = detectDeltas(tReopened.snapshot, {
    pr: [pr({ number: 10, state: 'MERGED', updatedAt: '2026-07-01T13:00:00Z' })],
    issue: [],
  });
  deltas.push(...tMerged.deltas);

  // missing / still-missing / presumed-deleted / reappeared
  const sM = detectDeltas(null, { pr: [pr({ number: 20 })], issue: [] });
  const m1 = detectDeltas(sM.snapshot, { pr: [], issue: [] });
  deltas.push(...m1.deltas);
  const m2 = detectDeltas(m1.snapshot, { pr: [], issue: [] });
  deltas.push(...m2.deltas);
  const m3 = detectDeltas(m2.snapshot, { pr: [], issue: [] });
  deltas.push(...m3.deltas);
  const back = detectDeltas(m3.snapshot, { pr: [pr({ number: 20 })], issue: [] });
  deltas.push(...back.deltas);

  // new-comments / comments-removed
  const sC = detectDeltas(null, { pr: [pr({ number: 30, totalCommentsCount: 3 })], issue: [] });
  const tMore = detectDeltas(sC.snapshot, {
    pr: [pr({ number: 30, totalCommentsCount: 5, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  deltas.push(...tMore.deltas);
  const tLess = detectDeltas(tMore.snapshot, {
    pr: [pr({ number: 30, totalCommentsCount: 2, updatedAt: '2026-07-01T12:00:00Z' })],
    issue: [],
  });
  deltas.push(...tLess.deltas);

  // updated (bare)
  const sU = detectDeltas(null, { pr: [pr({ number: 40 })], issue: [] });
  const tU = detectDeltas(sU.snapshot, {
    pr: [pr({ number: 40, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  deltas.push(...tU.deltas);

  // draft-ready / converted-to-draft
  const sD = detectDeltas(null, { pr: [pr({ number: 50, isDraft: true })], issue: [] });
  const tReady = detectDeltas(sD.snapshot, {
    pr: [pr({ number: 50, isDraft: false, updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  deltas.push(...tReady.deltas);
  const tDraft = detectDeltas(tReady.snapshot, {
    pr: [pr({ number: 50, isDraft: true, updatedAt: '2026-07-01T12:00:00Z' })],
    issue: [],
  });
  deltas.push(...tDraft.deltas);

  // ci-changed
  const sCi = detectDeltas(null, {
    pr: [
      pr({
        number: 60,
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
      }),
    ],
    issue: [],
  });
  const tCi = detectDeltas(sCi.snapshot, {
    pr: [
      pr({
        number: 60,
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        updatedAt: '2026-07-01T11:00:00Z',
      }),
    ],
    issue: [],
  });
  deltas.push(...tCi.deltas);

  // review-changed
  const sR = detectDeltas(null, {
    pr: [pr({ number: 70, reviewDecision: 'REVIEW_REQUIRED', latestReviews: [] })],
    issue: [],
  });
  const tR = detectDeltas(sR.snapshot, {
    pr: [
      pr({
        number: 70,
        reviewDecision: 'APPROVED',
        latestReviews: [
          {
            id: 'r1',
            author: { login: 'alice' },
            state: 'APPROVED',
            submittedAt: '2026-07-01T10:30:00Z',
            commit: { oid: 'c1' },
          },
        ],
        updatedAt: '2026-07-01T11:00:00Z',
      }),
    ],
    issue: [],
  });
  deltas.push(...tR.deltas);

  // became-mergeable / became-conflicting
  const sMg = detectDeltas(null, { pr: [pr({ number: 80, mergeable: 'CONFLICTING' })], issue: [] });
  const tMg = detectDeltas(sMg.snapshot, {
    pr: [pr({ number: 80, mergeable: 'MERGEABLE', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
  deltas.push(...tMg.deltas);
  const tCf = detectDeltas(tMg.snapshot, {
    pr: [pr({ number: 80, mergeable: 'CONFLICTING', updatedAt: '2026-07-01T12:00:00Z' })],
    issue: [],
  });
  deltas.push(...tCf.deltas);

  // head-changed (coexists with updated)
  const sH = detectDeltas(null, { pr: [pr({ number: 90, headRefOid: 'sha1' })], issue: [] });
  const tH = detectDeltas(sH.snapshot, {
    pr: [pr({ number: 90, headRefOid: 'sha2', updatedAt: '2026-07-01T11:00:00Z' })],
    issue: [],
  });
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
  const sT = detectDeltas(null, {
    pr: [
      pr({
        number: 100,
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('A', false), thread('B', true)],
      }),
    ],
    issue: [],
  });
  const tT = detectDeltas(sT.snapshot, {
    pr: [
      pr({
        number: 100,
        reviewThreads: 2,
        unresolvedReviewThreads: 1,
        reviewThreadNodes: [thread('A', true), thread('B', false)],
      }),
    ],
    issue: [],
  });
  deltas.push(...tT.deltas);

  // review-threads-changed (total moves, no identity added/resolved)
  const sRT = detectDeltas(null, {
    pr: [
      pr({
        number: 101,
        reviewThreads: 1,
        unresolvedReviewThreads: 0,
        reviewThreadNodes: [thread('X', true)],
      }),
    ],
    issue: [],
  });
  const tRT = detectDeltas(sRT.snapshot, {
    pr: [
      pr({
        number: 101,
        reviewThreads: 2,
        unresolvedReviewThreads: 0,
        updatedAt: '2026-07-01T11:00:00Z',
        reviewThreadNodes: [thread('X', true), thread('Y', true)],
      }),
    ],
    issue: [],
  });
  deltas.push(...tRT.deltas);

  // relabeled / assignees-changed / review-requests-changed / base-changed
  const sL = detectDeltas(null, {
    pr: [
      pr({
        number: 110,
        baseRefName: 'main',
        labels: [{ name: 'a' }],
        assignees: ['alice'],
        reviewRequests: [],
      }),
    ],
    issue: [],
  });
  const tL = detectDeltas(sL.snapshot, {
    pr: [
      pr({
        number: 110,
        baseRefName: 'dev',
        labels: [{ name: 'b' }],
        assignees: ['bob'],
        reviewRequests: ['carol'],
        updatedAt: '2026-07-01T11:00:00Z',
      }),
    ],
    issue: [],
  });
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
