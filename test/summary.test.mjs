// Semantic summary tests. The integration cases run REAL captured GitHub GraphQL
// payloads (test/fixtures/summaries/*.json, recorded from live PRs on 2026-07-11)
// through the exact fetchPRs -> normalizePr -> prFingerprint -> prSummary pipeline
// the CLI uses. Recording from real repos -- rather than hand-building rollup rows
// -- is deliberate: a constructed fixture that omitted the {status:'IN_PROGRESS',
// conclusion:null} shape is exactly the trap that let a bad "green" slip past a
// downstream consumer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchPRs } from '../lib/gh.mjs';
import { prFingerprint, canonicalizeCiRollup } from '../lib/fingerprint.mjs';
import {
  deriveCiRollup,
  normalizeReviewDecision,
  normalizeMergeable,
  normalizePrState,
  prSummary,
  deltaSummary,
} from '../lib/summary.mjs';

// Load a captured page fixture and run it through the real fetch/normalize path,
// returning the single normalized PR row exactly as the CLI would see it.
function fixtureRow(name) {
  const bytes = readFileSync(
    new URL(`./fixtures/summaries/pr-ci-${name}.json`, import.meta.url),
    'utf8',
  );
  const rows = fetchPRs('o/r', { exec: () => bytes, horizonCutoff: null });
  assert.equal(rows.length, 1, `fixture ${name} must contain exactly one PR`);
  return rows[0];
}

// --- deriveCiRollup: the load-bearing verdict --------------------------------

test('deriveCiRollup: zero checks is none, never green', () => {
  assert.equal(deriveCiRollup([]), 'none');
  assert.equal(deriveCiRollup(), 'none');
  assert.equal(deriveCiRollup(null), 'none');
});

test('deriveCiRollup: all-success checks are green', () => {
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'b', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]),
    'green',
  );
});

test('deriveCiRollup: NEUTRAL and SKIPPED are non-blocking (green)', () => {
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'b', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]),
    'green',
  );
});

test('deriveCiRollup: an in-progress CheckRun with empty conclusion is pending', () => {
  // The peer-review-critical case: a classifier that only read `conclusion` would
  // see '' (no token) and wrongly return green. Keying on `status` too fixes it.
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'b', status: 'IN_PROGRESS', conclusion: '' },
    ]),
    'pending',
  );
});

test('deriveCiRollup: StatusContext PENDING/EXPECTED are pending', () => {
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'PENDING', conclusion: 'PENDING' }]),
    'pending',
  );
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'EXPECTED', conclusion: 'EXPECTED' }]),
    'pending',
  );
});

test('deriveCiRollup: a failure dominates pending and success (fail-closed)', () => {
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'b', status: 'IN_PROGRESS', conclusion: '' },
      { name: 'c', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]),
    'failed',
  );
});

test('deriveCiRollup: StatusContext ERROR and CheckRun ACTION_REQUIRED are failed', () => {
  assert.equal(deriveCiRollup([{ name: 'ci', status: 'ERROR', conclusion: 'ERROR' }]), 'failed');
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }]),
    'failed',
  );
});

// --- enum normalizers --------------------------------------------------------

test('normalizeReviewDecision maps the GraphQL enum and empty to none', () => {
  assert.equal(normalizeReviewDecision('APPROVED'), 'approved');
  assert.equal(normalizeReviewDecision('CHANGES_REQUESTED'), 'changes_requested');
  assert.equal(normalizeReviewDecision('REVIEW_REQUIRED'), 'review_required');
  assert.equal(normalizeReviewDecision(''), 'none');
  assert.equal(normalizeReviewDecision(null), 'none');
  assert.equal(normalizeReviewDecision(undefined), 'none');
});

test('normalizeMergeable keeps UNKNOWN honest', () => {
  assert.equal(normalizeMergeable('MERGEABLE'), 'mergeable');
  assert.equal(normalizeMergeable('CONFLICTING'), 'conflicting');
  assert.equal(normalizeMergeable('UNKNOWN'), 'unknown');
  assert.equal(normalizeMergeable(''), 'unknown');
  assert.equal(normalizeMergeable(undefined), 'unknown');
});

test('normalizePrState lowercases the three PR states', () => {
  assert.equal(normalizePrState('OPEN'), 'open');
  assert.equal(normalizePrState('CLOSED'), 'closed');
  assert.equal(normalizePrState('MERGED'), 'merged');
});

// --- prSummary shape ---------------------------------------------------------

test('prSummary returns null for a missing observed state', () => {
  assert.equal(prSummary(null), null);
  assert.equal(prSummary(undefined), null);
});

test('prSummary normalizes types and names headSha unambiguously', () => {
  const summary = prSummary({
    state: 'OPEN',
    isDraft: false,
    ciChecks: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    review: 'APPROVED',
    mergeable: 'MERGEABLE',
    unresolvedReviewThreads: 0,
    head: 'a'.repeat(40),
  });
  assert.deepEqual(summary, {
    ciRollup: 'green',
    reviewDecision: 'approved',
    mergeable: 'mergeable',
    state: 'open',
    isDraft: false,
    unresolvedReviewThreads: 0,
    headSha: 'a'.repeat(40),
  });
  assert.equal(typeof summary.isDraft, 'boolean');
});

test('deltaSummary applies only to PR deltas with an observed to-state', () => {
  const to = { state: 'OPEN', ciChecks: [], review: '', mergeable: 'MERGEABLE' };
  assert.equal(deltaSummary({ entity: 'pr', to }).ciRollup, 'none');
  assert.equal(deltaSummary({ entity: 'issue', to }), null);
  assert.equal(deltaSummary({ entity: 'pr', to: null }), null);
  assert.equal(deltaSummary(null), null);
});

// --- integration against REAL captured payloads ------------------------------

test('real fixture: a PR with zero checks yields ciRollup none (the empty-rollup digest proves it)', () => {
  const row = fixtureRow('none');
  const fp = prFingerprint(row);
  assert.deepEqual(fp.ciChecks, [], 'the captured PR genuinely has no checks');
  // 'da39a3ee5e6b' is the frozen digest of an empty rollup (see fingerprint.test).
  assert.equal(canonicalizeCiRollup(row.statusCheckRollup), 'da39a3ee5e6b');
  assert.equal(prSummary(fp).ciRollup, 'none');
});

test('real fixture: an all-SUCCESS PR yields ciRollup green', () => {
  const fp = prFingerprint(fixtureRow('green'));
  assert.ok(fp.ciChecks.length >= 1, 'the captured PR has real checks');
  assert.ok(
    fp.ciChecks.every((c) => c.conclusion === 'SUCCESS'),
    'the captured green PR is genuinely all-success',
  );
  assert.equal(prSummary(fp).ciRollup, 'green');
});

test('real fixture: a PR with an in-progress CheckRun yields ciRollup pending', () => {
  const row = fixtureRow('pending');
  // Guard the fixture's realness: it must actually contain the in-progress,
  // empty-conclusion CheckRun shape this branch exists to classify.
  const hasInProgress = row.statusCheckRollup.some(
    (c) => c.status === 'IN_PROGRESS' && (c.conclusion === null || c.conclusion === undefined),
  );
  assert.ok(hasInProgress, 'fixture must carry a real in-progress CheckRun');
  assert.equal(prSummary(prFingerprint(row)).ciRollup, 'pending');
});

test('real fixture: a PR with a failing check yields ciRollup failed', () => {
  const row = fixtureRow('failed');
  const fp = prFingerprint(row);
  assert.ok(
    fp.ciChecks.some((c) => c.conclusion === 'FAILURE'),
    'fixture must carry a real failing check',
  );
  // And it also carries SKIPPED/SUCCESS rows -- proof the failure dominates them.
  assert.equal(prSummary(fp).ciRollup, 'failed');
});
