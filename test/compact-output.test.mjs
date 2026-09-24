import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactReport, ndjsonReport } from '../lib/compact-output.mjs';
import {
  AGENT_COMPACT_REPORT_FIELDS,
  AGENT_COMPACT_DELTA_FIELDS,
  AGENT_NDJSON_END_FIELDS,
} from '../lib/contract.mjs';

// compactDelta echoes delta.from/delta.to verbatim under --full (see below);
// it never inspects their shape. A real delta reaching compactReport has
// already been stripped to the bare compared fingerprint by runSingle (see
// lib/cli.mjs) -- not the full snapshot item -- but since this is a pure
// passthrough, wrapping it here does not affect what these tests verify.
const item = (fingerprint) => ({ fingerprint, context: {}, meta: {} });

// compactDelta is a pure pick: `context`/`summary`/`changed` must already be
// precomputed on the delta object (lib/cli.mjs's enrichDelta does this at
// assembly time), never recomputed here.
const delta = {
  id: 'x',
  repo: 'o/r',
  entity: 'pr',
  number: 7,
  context: { title: 'Fix' },
  classes: ['ci-changed'],
  from: item({
    state: 'open',
    checks: [{ name: 'lint', kind: 'check', status: 'completed', conclusion: 'failure' }],
  }),
  to: item({
    checks: [{ name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' }],
    state: 'open',
  }),
  summary: {
    ciRollup: 'green',
    reviewDecision: 'none',
    mergeable: 'unknown',
    mergeStateStatus: 'unknown',
    state: 'open',
    isDraft: false,
    unresolvedReviewThreads: 0,
    headSha: '',
    failedChecks: [],
  },
  changed: { checks: { fixed: ['lint'] } },
  details: [{ class: 'ci-changed' }],
  summaryLine: 'legacy',
};

function baseReport(overrides = {}) {
  return {
    schemaVersion: 2,
    detectedAt: 'now',
    repos: ['o/r'],
    results: [
      {
        repo: 'o/r',
        baseline: false,
        repoSource: 'flag',
        stateFile: '/tmp/state.json',
        rateLimit: null,
      },
    ],
    deltas: [delta],
    filteredDeltas: 0,
    ...overrides,
  };
}

test('compactReport emits self-contained agent deltas only', () => {
  const value = compactReport(baseReport(), 10, [], { detail: true });
  assert.deepEqual(value, {
    schemaVersion: 2,
    repos: ['o/r'],
    detectedAt: 'now',
    baseline: false,
    counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
    deltas: [
      {
        id: 'x',
        repo: 'o/r',
        entity: 'pr',
        number: 7,
        context: { title: 'Fix' },
        classes: ['ci-changed'],
        summary: delta.summary,
        changed: { checks: { fixed: ['lint'] } },
        detail: [{ class: 'ci-changed' }],
      },
    ],
    warnings: [],
  });
});

test('compactDelta includes from/to only under the full option', () => {
  const withoutFull = compactReport(baseReport(), 10, []);
  assert.equal(Object.hasOwn(withoutFull.deltas[0], 'from'), false);
  assert.equal(Object.hasOwn(withoutFull.deltas[0], 'to'), false);

  const withFull = compactReport(baseReport(), 10, [], { full: true });
  assert.deepEqual(withFull.deltas[0].from, delta.from);
  assert.deepEqual(withFull.deltas[0].to, delta.to);
});

test('ndjsonReport ends with an end record and newline', () => {
  const output = ndjsonReport(baseReport(), 10, []);
  const lines = output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'delta');
  assert.deepEqual(lines[1], {
    type: 'end',
    schemaVersion: 2,
    detectedAt: 'now',
    repos: ['o/r'],
    baseline: false,
    counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
    warnings: [],
    exitCode: 10,
  });
  assert.ok(output.endsWith('\n'));
});

test('a representative compact ci change without detail stays bounded', () => {
  const report = compactReport(baseReport(), 10);
  assert.ok(JSON.stringify(report.deltas[0]).length <= 600);
  assert.equal(Object.hasOwn(report.deltas[0], 'detail'), false);
});

test('a multi-repo report keeps repos plural and omits the single-repo baseline convenience', () => {
  const report = compactReport(
    baseReport({
      repos: ['o/r', 'o/r2'],
      results: [
        { repo: 'o/r', baseline: false, repoSource: 'flag', stateFile: '/a', rateLimit: null },
        { repo: 'o/r2', baseline: true, repoSource: 'flag', stateFile: '/b', rateLimit: null },
      ],
    }),
    10,
    [],
  );
  assert.deepEqual(report.repos, ['o/r', 'o/r2']);
  assert.equal(Object.hasOwn(report, 'baseline'), false);
});

test('a per-repo error folds into the compact errors array, keyed by repo', () => {
  const report = compactReport(
    baseReport({
      deltas: [],
      results: [
        {
          repo: 'o/r',
          baseline: false,
          repoSource: 'flag',
          stateFile: '/a',
          rateLimit: null,
          error: { kind: 'github', message: 'boom', hint: 'retry' },
        },
      ],
    }),
    1,
    [],
  );
  assert.deepEqual(report.errors, [
    { repo: 'o/r', kind: 'github', message: 'boom', hint: 'retry' },
  ]);
});

// Nothing else in lib/ or test/ consumes AGENT_COMPACT_REPORT_FIELDS,
// AGENT_COMPACT_DELTA_FIELDS, or AGENT_NDJSON_END_FIELDS (they are published
// on the `gh-delta/contract` subpath for external consumers only), so they
// can silently drift from what compactReport/ndjsonReport actually emit.
// Pin them against the union of two representative renders -- one exercising
// the happy single-repo path with every optional delta field, one exercising
// the per-repo error path -- so an added, removed, or renamed field in
// either direction breaks this test rather than quietly reaching consumers.
test('AGENT_COMPACT_*/AGENT_NDJSON_END_FIELDS catalogs match every key compact/ndjson can actually emit', () => {
  const fullDelta = { ...delta, missingTicks: 2, enrichment: { threadReplies: [] } };
  const happyReport = compactReport(baseReport({ deltas: [fullDelta] }), 10, [], {
    detail: true,
    full: true,
  });
  const errorReport = compactReport(
    baseReport({
      deltas: [],
      results: [
        {
          repo: 'o/r',
          baseline: false,
          repoSource: 'flag',
          stateFile: '/a',
          rateLimit: null,
          error: { kind: 'github', message: 'boom', hint: 'retry' },
        },
      ],
    }),
    1,
    [],
  );
  const emittedReportKeys = new Set([...Object.keys(happyReport), ...Object.keys(errorReport)]);
  assert.deepEqual([...emittedReportKeys].sort(), [...AGENT_COMPACT_REPORT_FIELDS].sort());
  assert.deepEqual(
    Object.keys(happyReport.deltas[0]).sort(),
    [...AGENT_COMPACT_DELTA_FIELDS].sort(),
  );

  const happyEnd = ndjsonReport(baseReport({ deltas: [fullDelta] }), 10, [], {
    detail: true,
    full: true,
  })
    .trimEnd()
    .split('\n')
    .map(JSON.parse)
    .at(-1);
  const errorEnd = ndjsonReport(
    baseReport({
      deltas: [],
      results: [
        {
          repo: 'o/r',
          baseline: false,
          repoSource: 'flag',
          stateFile: '/a',
          rateLimit: null,
          error: { kind: 'github', message: 'boom', hint: 'retry' },
        },
      ],
    }),
    1,
    [],
  )
    .trimEnd()
    .split('\n')
    .map(JSON.parse)
    .at(-1);
  const emittedEndKeys = new Set([...Object.keys(happyEnd), ...Object.keys(errorEnd)]);
  assert.deepEqual([...emittedEndKeys].sort(), [...AGENT_NDJSON_END_FIELDS].sort());
});

test('a bare pre-flight error renders without a repos key', () => {
  const report = compactReport(
    { schemaVersion: 2, at: 'now', error: 'bad flag', kind: 'config', hint: 'fix it' },
    2,
    [],
  );
  assert.equal(Object.hasOwn(report, 'repos'), false);
  assert.deepEqual(report.errors, [{ kind: 'config', message: 'bad flag', hint: 'fix it' }]);
  assert.deepEqual(report.deltas, []);
  // The bare pre-flight error shape only carries `at` (deliberately
  // unrenamed -- see lib/schema.mjs's bareError); compactReport's own
  // `detectedAt` field falls back to it so agent consumers always see a
  // timestamp under one name.
  assert.equal(report.detectedAt, 'now');
});
