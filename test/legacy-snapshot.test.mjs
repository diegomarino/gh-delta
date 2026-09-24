// ============================================================================
// TODO(R5): schema v2 (R1) removed the v1 upgrade-compat guards this suite
// pins (comparableFingerprint's drop-list, the additive-field/typeof/Array
// legacy checks in detect.mjs). The fixture below is a v1-shaped snapshot and
// is expected to fail loudly under v2 rather than converge silently -- R5
// deletes this file outright; do not re-enable these cases before then.
// ============================================================================
// Legacy snapshot round-trip. Byte-identity (test/contract-baseline.test.mjs)
// alone is not sufficient: a real fleet upgrading gh-delta reads a snapshot
// written by the OLD version on its first upgraded tick. If any comparison
// logic assumes a new field is present, that first tick produces phantom
// deltas or crashes.
//
// This suite pins: an old-shaped snapshot read by current code must yield
// ZERO spurious deltas and stable delta ids, and the upgrade must converge to
// the current snapshot shape in exactly one tick (no oscillation).
//
// See test/fixtures/legacy/README.md for exactly which fields the fixture
// snapshot omits and which released version it emulates.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.GH_DELTA_NO_REGISTRY = '1';

import { run } from '../lib/cli.mjs';

const legacySnapshot = JSON.parse(
  readFileSync(new URL('./fixtures/legacy/legacy-snapshot.json', import.meta.url), 'utf8'),
);

const REPO = 'acme/widgets';
const MONITOR_ID = 'legacy-roundtrip';
const STATE_FILE = '/tmp/gh-delta-legacy-roundtrip.json';
const ARGV = ['--repo', REPO, '--monitor-id', MONITOR_ID, '--state-file', STATE_FILE];

// The observation is current-shaped (carries mergeStateStatus/base/labels/
// assignees/reviewRequests, fields the legacy snapshot predates) but
// semantically unchanged relative to the legacy fingerprint: same state, ci,
// review, mergeable, comments, and head.
const unchangedPr = {
  number: 1,
  title: 'Add widget factory',
  state: 'OPEN',
  updatedAt: '2025-12-01T10:00:00Z',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  latestReviews: [],
  totalCommentsCount: 2,
  headRefOid: 'aaaaaaa1',
  headRefName: 'feature/widget-factory',
  reviewThreads: 0,
  unresolvedReviewThreads: 0,
  baseRefName: 'main',
  labels: [{ name: 'enhancement' }],
  assignees: ['alice'],
  reviewRequests: ['bob'],
};

const unchangedIssue = {
  number: 10,
  title: 'Widgets sometimes squeak',
  state: 'OPEN',
  updatedAt: '2025-12-01T09:00:00Z',
  labels: [{ name: 'bug' }],
  assignees: ['carol'],
  comments: 1,
};

function makeDeps(prReturn, issueReturn, at, existingSnapshot) {
  let stored = existingSnapshot;
  return {
    fetchPRs: () => prReturn,
    fetchIssues: () => issueReturn,
    readSnapshot: () => stored,
    writeSnapshotAtomic: (_path, data) => {
      stored = data;
    },
    now: () => at,
    env: {},
    get stored() {
      return stored;
    },
  };
}

// Deep-clone helper: the legacy fixture is shared across tests, and detect.mjs
// / snapshot writes must never mutate the fixture object in place.
function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

test.skip('legacy round-trip: unchanged state against a legacy snapshot yields zero deltas', () => {
  const deps = makeDeps(
    [unchangedPr],
    [unchangedIssue],
    '2026-01-01T00:00:00Z',
    cloneSnapshot(legacySnapshot),
  );
  const result = run(ARGV, deps);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
});

test.skip('legacy round-trip: one real change yields exactly its own delta class, no phantom classes from missing legacy fields', () => {
  const changedPr = { ...unchangedPr, totalCommentsCount: 3 }; // real change: new-comments
  const deps = makeDeps(
    [changedPr],
    [unchangedIssue],
    '2026-01-01T00:00:00Z',
    cloneSnapshot(legacySnapshot),
  );
  const result = run(ARGV, deps);
  assert.equal(result.code, 10);
  assert.equal(result.report.deltas.length, 1);
  const [delta] = result.report.deltas;
  assert.equal(delta.entity, 'pr');
  assert.equal(delta.number, 1);
  assert.deepEqual(delta.classes, ['new-comments']);
});

test.skip('legacy round-trip: the upgrade converges in one tick (no oscillation)', () => {
  // Tick 1: legacy snapshot in, semantically unchanged observation.
  const deps1 = makeDeps(
    [unchangedPr],
    [unchangedIssue],
    '2026-01-01T00:00:00Z',
    cloneSnapshot(legacySnapshot),
  );
  const result1 = run(ARGV, deps1);
  assert.equal(result1.code, 0);
  assert.deepEqual(result1.report.deltas, []);

  // The snapshot written after tick 1 must be upgraded in place to the
  // current field set on the PR fingerprint.
  const upgradedPrFingerprint = deps1.stored.pr['1'];
  for (const field of ['mergeStateStatus', 'base', 'labels', 'assignees', 'reviewRequests']) {
    assert.ok(
      Object.hasOwn(upgradedPrFingerprint, field),
      `snapshot written after the upgrade tick must carry "${field}"`,
    );
  }
  assert.equal(upgradedPrFingerprint.mergeStateStatus, 'CLEAN');
  assert.equal(upgradedPrFingerprint.base, 'main');
  assert.deepEqual(upgradedPrFingerprint.labels, ['enhancement']);
  assert.deepEqual(upgradedPrFingerprint.assignees, ['alice']);
  assert.deepEqual(upgradedPrFingerprint.reviewRequests, ['bob']);

  // Tick 2: feed the SAME unchanged observation against the now-upgraded
  // snapshot. A correctly converged upgrade yields zero deltas again -- if
  // the upgrade oscillated (e.g. re-reporting the additive fields as changed
  // a second time), this would fail.
  const deps2 = makeDeps([unchangedPr], [unchangedIssue], '2026-01-01T01:00:00Z', deps1.stored);
  const result2 = run(ARGV, deps2);
  assert.equal(result2.code, 0);
  assert.deepEqual(result2.report.deltas, []);
});
