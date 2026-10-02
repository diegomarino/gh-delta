// CLI contract tests: --detail, summaries, and --baseline-emit-state.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basePr,
  item,
  openFp,
  NOOP_LOCK_DEPS,
  RATE_LIMIT,
  DEFAULT_OLD_META,
  deps,
  opaqueCiFixture,
  SUMMARIES_ARGS,
  BASELINE_EMIT_ARGS,
  FILTER_ARGS,
} from './helpers/cli-fixtures.mjs';
import { run } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { DELTA_DETAIL_FIELDS_BY_CLASS } from '../lib/contract.mjs';

test('--summary-line attaches only the human summary line to each delta', () => {
  const d = deps([[{ ...basePr, conversationComments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: { 42: item(opaqueCiFixture()) },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--summary-line'],
    d,
  );
  assert.equal(report.deltas[0].summaryLine, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(report.deltas[0].line, undefined);
  assert.equal(report.deltas[0].details, undefined);
});

test('--detail adds summaryLine and structured class details', () => {
  const d = deps([[{ ...basePr, conversationComments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: { 42: item(opaqueCiFixture()) },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const delta = report.deltas[0];
  assert.equal(delta.summaryLine, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(Object.hasOwn(delta, 'line'), false);
  assert.deepEqual(delta.details, [
    {
      class: 'ci-changed',
      field: 'checks',
      from: null,
      to: [],
      opaque: true,
    },
    {
      class: 'new-comments',
      field: 'conversationComments',
      from: 0,
      to: 2,
      delta: 2,
      opaque: true,
    },
  ]);
});

test('--detail explains the audit-driven classes: set diffs, base transition, comment removal', () => {
  const before = {
    ...basePr,
    conversationComments: 3,
    baseRef: 'main',
    assignees: ['alice'],
    reviewRequests: [],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    conversationComments: 2,
    baseRef: 'release/2.0',
    assignees: ['bob'],
    reviewRequests: ['carol', 'org/platform-team'],
  };
  const d = deps([[after]], {
    existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const delta = report.deltas[0];
  for (const klass of [
    'comments-removed',
    'base-changed',
    'assignees-changed',
    'review-requests-changed',
  ]) {
    assert.ok(delta.classes.includes(klass), `expected class ${klass}`);
  }
  const details = delta.details;
  assert.deepEqual(
    details.find((row) => row.class === 'comments-removed'),
    {
      class: 'comments-removed',
      field: 'conversationComments',
      from: 3,
      to: 2,
      delta: -1,
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'base-changed'),
    {
      class: 'base-changed',
      field: 'baseRef',
      from: 'main',
      to: 'release/2.0',
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'assignees-changed'),
    {
      class: 'assignees-changed',
      field: 'assignees',
      added: ['bob'],
      removed: ['alice'],
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'review-requests-changed'),
    {
      class: 'review-requests-changed',
      field: 'reviewRequests',
      added: ['carol', 'org/platform-team'],
      removed: [],
    },
  );
});

test('--detail names the added and removed thread ids for a same-count thread swap (P2-1)', () => {
  // The swap case this feature exists for: totals are unchanged (one thread
  // resolves while another reopens), so pushNumericDelta returns nothing for
  // unresolvedReviewThreads. Without a dedicated thread-identity detail row,
  // `--detail` would name nothing at all for either class.
  const before = {
    ...basePr,
    threads: [
      { id: 'RT_1', resolved: false },
      { id: 'RT_2', resolved: true },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    threads: [
      { id: 'RT_1', resolved: true },
      { id: 'RT_2', resolved: false },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('unresolved-threads-added'));
  assert.ok(delta.classes.includes('unresolved-threads-resolved'));

  const addedRow = delta.details.find(
    (row) => row.class === 'unresolved-threads-added' && row.field === 'threads',
  );
  const resolvedRow = delta.details.find(
    (row) => row.class === 'unresolved-threads-resolved' && row.field === 'threads',
  );
  assert.ok(addedRow, 'unresolved-threads-added must name the swap even though the count held');
  assert.ok(
    resolvedRow,
    'unresolved-threads-resolved must name the swap even though the count held',
  );
  assert.deepEqual(addedRow.added, ['RT_2']);
  assert.deepEqual(addedRow.removed, ['RT_1']);
  assert.deepEqual(resolvedRow.added, ['RT_2']);
  assert.deepEqual(resolvedRow.removed, ['RT_1']);

  // The numeric row is genuinely absent: the count did not move.
  assert.ok(!delta.details.some((row) => row.field === 'unresolvedReviewThreads'));
});

test('--detail does not leak threads into generic updated rows (P2-2)', () => {
  // Head SHA and thread states change in the same tick: both are specific
  // classes (head-changed decoupled from updated per R6; unresolved-threads-*
  // always specific), so `updated` never fires here at all -- and `threads`'
  // meaningful expression is the dedicated `threads` row on
  // unresolved-threads-*, never a generic `updated` field row (which the
  // exported contract does not declare for the `updated` class).
  const before = {
    ...basePr,
    headSha: 'sha1',
    threads: [
      { id: 'RT_1', resolved: false },
      { id: 'RT_2', resolved: true },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    threads: [
      { id: 'RT_1', resolved: true },
      { id: 'RT_2', resolved: false },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(!delta.classes.includes('updated'));
  assert.ok(delta.classes.includes('head-changed'));

  const updatedFields = delta.details
    .filter((row) => row.class === 'updated')
    .map((row) => row.field);
  assert.deepEqual(updatedFields, []);
  assert.ok(!updatedFields.includes('threads'));

  // Every emitted key must fall within the declared contract for its class.
  for (const row of delta.details) {
    const allowed = DELTA_DETAIL_FIELDS_BY_CLASS[row.class];
    assert.ok(allowed, `no field map for class "${row.class}"`);
    if (!['presence', 'unknown'].includes(row.field)) {
      assert.ok(
        allowed.includes(row.field),
        `field "${row.field}" not declared for class "${row.class}"`,
      );
    }
  }
});

test('an updated delta with a same-count recentComments rotation does not emit an undeclared detail field', () => {
  // recentComments is a bounded rolling window: one comment can drop off
  // while another enters, leaving conversationComments unchanged but the
  // window's contents different. That rotation alone must not surface as an
  // `updated` detail field -- recentComments is deliberately excluded from
  // changedFingerprintFields (see lib/cli.mjs) and is not declared in
  // DELTA_DETAIL_FIELDS_BY_CLASS.updated.
  const before = {
    ...basePr,
    recentComments: [{ id: 'C1', author: 'alice' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    recentComments: [{ id: 'C2', author: 'bob' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('updated'));
  const updatedFields = delta.details
    .filter((row) => row.class === 'updated')
    .map((row) => row.field);
  assert.ok(!updatedFields.includes('recentComments'));

  for (const row of delta.details) {
    const allowed = DELTA_DETAIL_FIELDS_BY_CLASS[row.class];
    assert.ok(allowed, `no field map for class "${row.class}"`);
    if (!['presence', 'unknown'].includes(row.field)) {
      assert.ok(
        allowed.includes(row.field),
        `field "${row.field}" not declared for class "${row.class}"`,
      );
    }
  }
});

test('--detail names the exact checks and reviews that changed when the snapshot carries summaries', () => {
  const before = {
    ...basePr,
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
      { name: 'docs', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
    reviewDecision: 'changes_requested',
    reviews: [
      {
        id: 'r1',
        submittedAt: '2026-07-01T09:00:00Z',
        author: 'alice',
        state: 'changes_requested',
        commit: 'c1',
      },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      { name: 'lint', kind: 'check', status: 'in_progress', conclusion: '' },
    ],
    reviewDecision: 'approved',
    reviews: [
      {
        id: 'r2',
        submittedAt: '2026-07-01T10:30:00Z',
        author: 'alice',
        state: 'approved',
        commit: 'c2',
      },
      {
        id: 'r3',
        submittedAt: '2026-07-01T10:31:00Z',
        author: 'bob',
        state: 'commented',
        commit: 'c2',
      },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const details = report.deltas[0].details;

  const ci = details.find((row) => row.class === 'ci-changed');
  assert.equal(ci.opaque, undefined);
  assert.deepEqual(ci.added, [
    { name: 'lint', kind: 'check', status: 'in_progress', conclusion: '' },
  ]);
  assert.deepEqual(ci.removed, [
    { name: 'docs', kind: 'check', status: 'completed', conclusion: 'success' },
  ]);
  assert.deepEqual(ci.changed, [
    {
      name: 'build',
      from: { kind: 'check', status: 'completed', conclusion: 'failure' },
      to: { kind: 'check', status: 'completed', conclusion: 'success' },
    },
  ]);

  // Reviews are keyed by `id` (always present in schema v2, unlike author,
  // which collides whenever the same person reviews more than once): a new
  // review from the same author on approval is a distinct id, not an
  // in-place "changed" row.
  const reviews = details.find((row) => row.field === 'reviews');
  assert.equal(reviews.opaque, undefined);
  assert.deepEqual(reviews.added, [
    {
      id: 'r2',
      author: 'alice',
      state: 'approved',
      submittedAt: '2026-07-01T10:30:00Z',
      commit: 'c2',
    },
    {
      id: 'r3',
      author: 'bob',
      state: 'commented',
      submittedAt: '2026-07-01T10:31:00Z',
      commit: 'c2',
    },
  ]);
  assert.deepEqual(reviews.removed, [
    {
      id: 'r1',
      author: 'alice',
      state: 'changes_requested',
      submittedAt: '2026-07-01T09:00:00Z',
      commit: 'c1',
    },
  ]);
  assert.deepEqual(reviews.changed, []);
  const decision = details.find((row) => row.field === 'reviewDecision');
  assert.deepEqual(decision, {
    class: 'review-changed',
    field: 'reviewDecision',
    from: 'changes_requested',
    to: 'approved',
  });
});

test('--detail falls back to opaque when duplicate check names would collapse the diff', () => {
  // Two rollup rows can share a name (e.g. a CheckRun and a StatusContext).
  // Keying the diff by name would silently drop the removed failing `build`
  // row and misreport `lint` as the only change, so the detail must refuse to
  // name the breakdown instead.
  const before = {
    ...basePr,
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      { name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const ci = report.deltas[0].details.find((row) => row.class === 'ci-changed');
  assert.equal(ci.opaque, true);
  assert.equal(ci.added, undefined);
  assert.equal(ci.removed, undefined);
  assert.equal(ci.changed, undefined);
});

test('--summaries acceptance: posting a successful status makes summary.ciRollup green', () => {
  // A PR with zero checks, re-observed after a successful commit status lands on
  // the head: a ci-changed delta whose semantic summary reports the CI as green.
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('ci-changed'), 'the status transition is a ci-changed delta');
  assert.deepEqual(delta.summary, {
    ciRollup: 'green',
    reviewDecision: 'review_required',
    mergeable: 'unknown',
    mergeStateStatus: 'unknown',
    state: 'open',
    isDraft: false,
    unresolvedReviewThreads: 0,
    headSha: 'sha1',
    failedChecks: [],
  });
});

test('--summaries acceptance: a new PR with a failing check carries failedChecks[0].runId without --detail', () => {
  // F4: summary.failedChecks must be populated for a PR that is already red on
  // first observation (a `new` delta, not a `ci-changed` transition), and
  // without --detail -- a merge gate should not need structured details to
  // read the failing check's run id.
  const pr = {
    ...basePr,
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      {
        name: 'lint',
        kind: 'check',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: 'https://github.com/o/r/actions/runs/111222333/job/444555666',
      },
    ],
  };
  const d = deps([[pr]], { existing: { pr: {}, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  const delta = report.deltas.find((x) => x.number === 42);
  assert.ok(delta.classes.includes('new'), 'first observation of a tracked PR is a new delta');
  assert.deepEqual(delta.summary.failedChecks, [
    {
      name: 'lint',
      runId: '111222333',
      jobId: '444555666',
      detailsUrl: 'https://github.com/o/r/actions/runs/111222333/job/444555666',
    },
  ]);
  assert.equal(delta.details, undefined, 'the acceptance case explicitly omits --detail');
});

test('--summaries surfaces mergeStateStatus behind for an up-to-date-required branch', () => {
  // A PR that GitHub reports mergeable yet BEHIND its base (repos requiring the
  // branch be up to date): the summary must expose that distinctly so a consumer
  // does not emit a false "ready to merge".
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    mergeStateStatus: 'behind',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  assert.equal(report.deltas[0].summary.mergeStateStatus, 'behind');
});

test('a mergeStateStatus-only transition fires an updated delta end-to-end', () => {
  // Base branch advanced: the same PR goes CLEAN -> BEHIND with nothing else
  // changed. gh-delta must emit a delta (exit 10) carrying the new summary, or a
  // consumer never re-evaluates merge readiness.
  const before = { ...basePr, mergeStateStatus: 'clean' };
  const after = { ...basePr, mergeStateStatus: 'behind' };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['updated']);
  assert.equal(report.deltas[0].summary.mergeStateStatus, 'behind');
});

test('--baseline-emit-state off: baseline stays exit 0 with empty deltas', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.results[0].baseline, true);
  assert.deepEqual(report.deltas, []);
});

test('--baseline-emit-state on: baseline exits 10 with baseline:true and non-empty deltas', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(BASELINE_EMIT_ARGS, d);
  assert.equal(code, 10);
  assert.equal(report.results[0].baseline, true);
  assert.equal(report.deltas.length, 1);
  const delta = report.deltas[0];
  assert.deepEqual(delta.classes, ['baseline-state']);
  assert.equal(delta.from, null);
  assert.equal(delta.to.state, 'open');
  assert.match(delta.id, /^[0-9a-f]{64}$/);
});

test('--baseline-emit-state ids are stable across a re-baseline over unchanged state', () => {
  // Fresh state both times (readSnapshot returns null), same observed PR: the
  // content-addressed id must match so idempotent consumers dedupe for free.
  const first = run(BASELINE_EMIT_ARGS, deps([[basePr]]));
  const second = run(BASELINE_EMIT_ARGS, deps([[basePr]]));
  assert.equal(first.report.deltas[0].id, second.report.deltas[0].id);
});

test('--baseline-emit-state composes with --summaries (PR baseline-state carries a summary)', () => {
  const d = deps([[basePr]]);
  const { code, report } = run([...BASELINE_EMIT_ARGS, '--summaries'], d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.equal(delta.classes[0], 'baseline-state');
  assert.equal(delta.summary.state, 'open');
  assert.equal(delta.summary.mergeStateStatus, 'unknown');
});

test('--help-json advertises --baseline-emit-state', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { report } = run(['--help-json'], d);
  const help = JSON.parse(report);
  assert.ok(help.options.some((o) => o.name === '--baseline-emit-state'));
});

test('--summaries acceptance: a PR that lost its checks reports ciRollup none, not green', () => {
  const before = {
    ...basePr,
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const after = { ...basePr, updatedAt: '2026-07-01T11:00:00Z', checks: [] };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('ci-changed'));
  assert.equal(delta.summary.ciRollup, 'none');
});

test('--summaries is a deprecated no-op: delta.summary is byte-identical with or without it', () => {
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const seed = () => ({ pr: { 42: item(prFingerprint(before)) }, issue: {} });
  const baseArgs = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];
  const withFlag = run([...baseArgs, '--summaries'], deps([[after]], { existing: seed() })).report
    .deltas[0];
  const without = run(baseArgs, deps([[after]], { existing: seed() })).report.deltas[0];
  // summary/changed are always-on now (schema v2): the flag makes no
  // difference at all, not even an additive one.
  assert.equal(withFlag.id, without.id);
  assert.ok(without.summary, 'summary is present regardless of the flag');
  assert.deepEqual(withFlag, without);
});

test('--detail explains check, review, and comment identity metadata carried in the fingerprint', () => {
  // Schema v2: checks/reviews/recentComments/conversationComments are
  // ordinary `fingerprint` fields now (no more hideInternalDetails gate), so
  // they are always present in `to`/`from`, with or without --detail. What
  // --detail adds is the structured, named breakdown in `details`.
  const before = {
    ...basePr,
    checks: [
      {
        name: 'build',
        kind: 'check',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://ci/old',
      },
    ],
    reviews: [
      {
        id: 'R1',
        submittedAt: '2026-07-01T09:00:00Z',
        author: 'alice',
        state: 'approved',
        commit: 'a',
      },
    ],
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      {
        name: 'build',
        kind: 'check',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: 'https://ci/build',
      },
    ],
    reviews: [
      {
        id: 'R2',
        submittedAt: '2026-07-01T10:00:00Z',
        author: 'alice',
        state: 'changes_requested',
        commit: 'b',
      },
    ],
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'bot' },
    ],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const plain = run(FILTER_ARGS, deps([[after]], { existing })).report.deltas[0];
  assert.equal(JSON.stringify(plain).includes('https://ci/build'), true);
  assert.equal(JSON.stringify(plain).includes('R2'), true);
  assert.equal(JSON.stringify(plain).includes('C1'), true);
  const detailed = run([...FILTER_ARGS, '--detail'], deps([[after]], { existing })).report
    .deltas[0];
  assert.equal(
    detailed.details.find((row) => row.field === 'checks').changed[0].to.detailsUrl,
    'https://ci/build',
  );
  // Reviews are keyed by id (always present): R1 -> R2 on the same PR is a
  // distinct review, so it surfaces as added/removed, not an in-place change.
  assert.equal(detailed.details.find((row) => row.field === 'reviews').added[0].id, 'R2');
  assert.deepEqual(
    detailed.details.find((row) => row.class === 'new-comments'),
    {
      class: 'new-comments',
      field: 'conversationComments',
      from: 1,
      to: 2,
      delta: 1,
      added: [{ id: 'C1', author: 'bot' }],
    },
  );
});

test('--help-json documents the summary schema well enough to build a validator', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help-json'], d);
  assert.equal(code, 0);
  const help = JSON.parse(report);
  assert.ok(help.output.deltaFields.includes('summary'), 'deltaFields advertises summary');
  assert.deepEqual(help.output.deltaSummaryFields, [
    'ciRollup',
    'reviewDecision',
    'mergeable',
    'mergeStateStatus',
    'state',
    'isDraft',
    'unresolvedReviewThreads',
    'headSha',
    'failedChecks',
  ]);
  assert.deepEqual(help.output.deltaSummaryEnums.ciRollup, ['green', 'failed', 'pending', 'none']);
  assert.deepEqual(help.output.deltaSummaryEnums.mergeable, [
    'mergeable',
    'conflicting',
    'unknown',
  ]);
  assert.deepEqual(help.output.deltaSummaryEnums.mergeStateStatus, [
    'behind',
    'blocked',
    'clean',
    'dirty',
    'draft',
    'has_hooks',
    'unstable',
    'unknown',
  ]);
});

test('--detail reports the current missing tick for still-missing', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({
      pr: {
        42: item(openFp, { missingTicks: 1 }),
      },
      issue: {},
      meta: DEFAULT_OLD_META,
    }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--entities',
      'pr',
      '--detail',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['still-missing']);
  assert.equal(report.deltas[0].missingTicks, 2);
  assert.equal(report.deltas[0].details[0].missingTicks, 2);
});
