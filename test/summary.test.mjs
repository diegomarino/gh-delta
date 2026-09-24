// Semantic summary tests. The integration cases run REAL captured GitHub GraphQL
// payloads (test/fixtures/summaries/*.json, recorded from live PRs on 2026-07-11)
// through the exact fetchPRs -> normalizePr -> prFingerprint -> prSummary pipeline
// the CLI uses. Recording from real repos -- rather than hand-building rollup rows
// -- is deliberate: a constructed fixture that omitted the {status:'in_progress',
// conclusion:''} shape is exactly the trap that let a bad "green" slip past a
// downstream consumer.
//
// Schema v2 (R2) lowercases every enum at the lib/gh.mjs fetch boundary and
// drops the opaque ci/reviews digests: `checks` is the sole, legible,
// compared representation, and deriveCiRollup trusts it is already lowercase
// -- no upper()/case-mapping tables survive here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchPRs } from '../lib/gh.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { deriveCiRollup, prSummary, deltaSummary } from '../lib/summary.mjs';

// Load a captured page fixture and run it through the real fetch/normalize path,
// returning the single normalized PR row exactly as the CLI would see it.
function fixtureRow(name) {
  const bytes = readFileSync(
    new URL(`./fixtures/summaries/pr-ci-${name}.json`, import.meta.url),
    'utf8',
  );
  const { rows } = fetchPRs('o/r', { exec: () => bytes, horizonCutoff: null });
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
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'success' },
    ]),
    'green',
  );
});

test('deriveCiRollup: neutral and skipped are non-blocking (green)', () => {
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'neutral' },
      { name: 'c', status: 'completed', conclusion: 'skipped' },
    ]),
    'green',
  );
});

test('deriveCiRollup: an in-progress CheckRun with empty conclusion is pending', () => {
  // The peer-review-critical case: a classifier that only read `conclusion` would
  // see '' (no token) and wrongly return green. Keying on `status` too fixes it.
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'in_progress', conclusion: '' },
    ]),
    'pending',
  );
});

test('deriveCiRollup: StatusContext pending/expected are pending', () => {
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'pending', conclusion: 'pending' }]),
    'pending',
  );
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'expected', conclusion: 'expected' }]),
    'pending',
  );
});

test('deriveCiRollup: a failure dominates pending and success (fail-closed)', () => {
  assert.equal(
    deriveCiRollup([
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'in_progress', conclusion: '' },
      { name: 'c', status: 'completed', conclusion: 'failure' },
    ]),
    'failed',
  );
});

test('deriveCiRollup: StatusContext error and CheckRun action_required are failed', () => {
  assert.equal(deriveCiRollup([{ name: 'ci', status: 'error', conclusion: 'error' }]), 'failed');
  assert.equal(
    deriveCiRollup([{ name: 'ci', status: 'completed', conclusion: 'action_required' }]),
    'failed',
  );
});

test('deriveCiRollup: no uppercase input is recognized (case mapping lives upstream at lib/gh.mjs, not here)', () => {
  // R2 deleted the upper()/case-mapping tables: this layer trusts the
  // fingerprint is already lowercase. Feeding it raw GraphQL-cased tokens must
  // NOT be silently rescued -- that would mask a normalization bug upstream.
  assert.equal(
    deriveCiRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }]),
    'green',
  );
});

// --- prSummary shape ---------------------------------------------------------

test('prSummary returns null for a missing observed state', () => {
  assert.equal(prSummary(null), null);
  assert.equal(prSummary(undefined), null);
});

test('prSummary reads already-normalized fields and names headSha unambiguously', () => {
  const summary = prSummary({
    state: 'open',
    isDraft: false,
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviewDecision: 'approved',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    threads: [],
    headSha: 'a'.repeat(40),
  });
  assert.deepEqual(summary, {
    ciRollup: 'green',
    reviewDecision: 'approved',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    state: 'open',
    isDraft: false,
    unresolvedReviewThreads: 0,
    headSha: 'a'.repeat(40),
    failedChecks: [],
  });
  assert.equal(typeof summary.isDraft, 'boolean');
});

test('prSummary defaults reviewDecision/mergeable/mergeStateStatus to their none/unknown sentinels', () => {
  const summary = prSummary({ state: 'open' });
  assert.equal(summary.reviewDecision, 'none');
  assert.equal(summary.mergeable, 'unknown');
  assert.equal(summary.mergeStateStatus, 'unknown');
  assert.equal(summary.headSha, '');
  assert.equal(summary.unresolvedReviewThreads, 0);
});

test('prSummary counts unresolvedReviewThreads from threads[], not a stored counter', () => {
  const summary = prSummary({
    state: 'open',
    threads: [
      { id: 'T_A', resolved: false },
      { id: 'T_B', resolved: true },
      { id: 'T_C', resolved: false },
    ],
  });
  assert.equal(summary.unresolvedReviewThreads, 2);
});

test('prSummary.failedChecks lists only the failing checks, carrying runId/jobId when parsed', () => {
  const summary = prSummary({
    state: 'open',
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      {
        name: 'lint',
        kind: 'check',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
        runId: '1',
        jobId: '2',
      },
      {
        name: 'ci/legacy',
        kind: 'status',
        status: 'error',
        conclusion: 'error',
        detailsUrl: 'https://ci.example.com/build/9',
      },
    ],
  });
  assert.deepEqual(summary.failedChecks, [
    {
      name: 'lint',
      runId: '1',
      jobId: '2',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
    },
    { name: 'ci/legacy', detailsUrl: 'https://ci.example.com/build/9' },
  ]);
  assert.equal('runId' in summary.failedChecks[1], false, 'unparsed row omits runId, not null');
});

test('prSummary.failedChecks is empty for a PR with no checks or no failing checks', () => {
  assert.deepEqual(prSummary({ state: 'open' }).failedChecks, []);
  assert.deepEqual(
    prSummary({
      state: 'open',
      checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    }).failedChecks,
    [],
  );
});

test('deltaSummary dispatches by entity and requires an observed to-state', () => {
  // `to` is a snapshot item (`{ fingerprint, context, meta }`); deltaSummary
  // reads only `to.fingerprint`.
  const to = {
    fingerprint: { state: 'open', checks: [], reviewDecision: 'none', mergeable: 'mergeable' },
    context: {},
    meta: {},
  };
  assert.equal(deltaSummary({ entity: 'pr', to }).ciRollup, 'none');
  assert.deepEqual(deltaSummary({ entity: 'issue', to }), { state: 'open' });
  assert.equal(deltaSummary({ entity: 'pr', to: null }), null);
  assert.equal(deltaSummary({ entity: 'issue', to: null }), null);
  assert.equal(deltaSummary(null), null);
});

// --- integration against REAL captured payloads ------------------------------

test('real fixture: a PR with zero checks yields ciRollup none (the empty rollup proves it)', () => {
  const row = fixtureRow('none');
  const fp = prFingerprint(row);
  assert.deepEqual(fp.checks, [], 'the captured PR genuinely has no checks');
  assert.equal(prSummary(fp).ciRollup, 'none');
});

test('real fixture: an older recording without mergeStateStatus yields unknown (fail-closed)', () => {
  // The captured payloads predate the field (the query did not request it), so the
  // summary must default to unknown — the same "not computed" signal as
  // mergeable: unknown — rather than inventing a merge-readiness verdict.
  const fp = prFingerprint(fixtureRow('green'));
  assert.equal(prSummary(fp).mergeStateStatus, 'unknown');
});

test('real fixture: an all-success PR yields ciRollup green', () => {
  const fp = prFingerprint(fixtureRow('green'));
  assert.ok(fp.checks.length >= 1, 'the captured PR has real checks');
  assert.ok(
    fp.checks.every((c) => c.conclusion === 'success'),
    'the captured green PR is genuinely all-success',
  );
  assert.equal(prSummary(fp).ciRollup, 'green');
});

test('real fixture: a PR with an in-progress CheckRun yields ciRollup pending', () => {
  const row = fixtureRow('pending');
  // Guard the fixture's realness: it must actually contain the in-progress,
  // empty-conclusion CheckRun shape this branch exists to classify.
  const hasInProgress = row.checks.some(
    (c) => c.status === 'in_progress' && (c.conclusion === '' || c.conclusion == null),
  );
  assert.ok(hasInProgress, 'fixture must carry a real in-progress CheckRun');
  assert.equal(prSummary(prFingerprint(row)).ciRollup, 'pending');
});

test('real fixture: a PR with a failing check yields ciRollup failed', () => {
  const row = fixtureRow('failed');
  const fp = prFingerprint(row);
  assert.ok(
    fp.checks.some((c) => c.conclusion === 'failure'),
    'fixture must carry a real failing check',
  );
  // And it also carries skipped/success rows -- proof the failure dominates them.
  assert.equal(prSummary(fp).ciRollup, 'failed');
});
