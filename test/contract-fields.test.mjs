// Guard: the frozen field catalogs lib/contract.mjs exports (REPORT_FIELDS,
// REPORT_RESULT_FIELDS, DELTA_FIELDS, DELTA_SUMMARY_FIELDS) are documentation
// shaped like code -- nothing at runtime reads them to build the actual
// report/delta/summary shapes, so nothing stops them from drifting away from
// what a real run emits (see the schema-v2 epic's F3/F10-class findings,
// where AGENT_COMPACT_*/AGENT_NDJSON_END_FIELDS silently went stale for an
// entire epic with `npm run check` green throughout).
//
// This file drives the REAL detector (`runCommand`) through a sequence of
// ticks against a real filesystem state/log, and the real `prSummary` output
// carried on a real delta's `summary` field -- never a hand-authored literal
// standing in for what the code would produce -- then asserts each catalog's
// field set against the UNION of keys actually observed across every
// representative record. AGENT_COMPACT_REPORT_FIELDS/AGENT_COMPACT_DELTA_FIELDS/
// AGENT_NDJSON_END_FIELDS already have an equivalent real-output guard in
// test/compact-output.test.mjs and are not duplicated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/cli.mjs';
import {
  REPORT_FIELDS,
  REPORT_RESULT_FIELDS,
  DELTA_FIELDS,
  DELTA_SUMMARY_FIELDS,
} from '../lib/contract.mjs';

const REPO = 'acme/widgets';
const MONITOR_ID = 'contract-fields';
const T0 = '2026-02-01T00:00:00.000Z';
const T2H = '2026-02-01T02:00:00.000Z';
const T3H = '2026-02-01T03:00:00.000Z';

function pr1(overrides = {}) {
  return {
    number: 1,
    id: 'PR_1',
    title: 'Add widget factory',
    url: 'https://github.com/acme/widgets/pull/1',
    author: 'alice',
    createdAt: '2026-01-01T09:00:00Z',
    headRefName: 'feature/widget-factory',
    state: 'open',
    updatedAt: T0,
    isDraft: false,
    headSha: 'aaaaaaa1',
    baseRef: 'main',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'review_required',
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviews: [],
    threads: [],
    conversationComments: 2,
    reviewComments: 0,
    recentComments: [],
    labels: [{ name: 'enhancement' }],
    assignees: ['alice'],
    reviewRequests: ['bob'],
    ...overrides,
  };
}

function pr2New() {
  return {
    number: 2,
    id: 'PR_2',
    title: 'Add gadget',
    url: 'https://github.com/acme/widgets/pull/2',
    author: 'bob',
    createdAt: T2H,
    headRefName: 'feature/gadget',
    state: 'open',
    updatedAt: T2H,
    isDraft: false,
    headSha: 'bbbbbbb1',
    baseRef: 'main',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'none',
    checks: [],
    reviews: [],
    threads: [],
    conversationComments: 0,
    reviewComments: 0,
    recentComments: [],
    labels: [],
    assignees: [],
    reviewRequests: [],
  };
}

function issue10(overrides = {}) {
  return {
    number: 10,
    id: 'ISSUE_10',
    title: 'Widgets sometimes squeak',
    url: 'https://github.com/acme/widgets/issues/10',
    author: 'carol',
    createdAt: '2026-01-01T08:00:00Z',
    state: 'open',
    updatedAt: T0,
    labels: [{ name: 'bug' }],
    assignees: ['carol'],
    conversationComments: 1,
    recentComments: [],
    ...overrides,
  };
}

test('REPORT_FIELDS/REPORT_RESULT_FIELDS/DELTA_FIELDS/DELTA_SUMMARY_FIELDS match real emitted output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-'));
  const stateFile = join(dir, 'state.json');
  try {
    const argv = () => [
      '--repo',
      REPO,
      '--monitor-id',
      MONITOR_ID,
      '--state-file',
      stateFile,
      '--log',
      '--detail',
      '--enrich',
      'comments',
      '--stale-after',
      '1h',
    ];

    // Tick 1 (T0): seed the baseline -- PR #1 and issue #10.
    const tick1 = await runCommand(argv(), {
      fetchPRs: () => ({ rows: [pr1()], rateLimit: null }),
      fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
      now: () => T0,
      env: {},
    });
    assert.equal(tick1.code, 0);
    assert.equal(tick1.report.results[0].baseline, true);

    // Tick 2 (T0+2h): PR #1 gets a new comment (new-comments -> enrichment)
    // and a relabel; PR #2 appears for the first time (new -> firstObserved);
    // issue #10 sits unchanged past --stale-after 1h (stale -> staleAt).
    const tick2 = await runCommand(argv(), {
      fetchPRs: () => ({
        rows: [
          pr1({ conversationComments: 3, recentComments: [{ id: 'C_1', body: 'ping @bob' }] }),
          pr2New(),
        ],
        rateLimit: null,
      }),
      fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
      fetchEnrichment: (_kind, ids) => ({
        rows: [{ id: ids[0], author: 'alice', createdAt: T2H, body: 'ping @bob' }],
        rateLimit: null,
      }),
      now: () => T2H,
      env: {},
    });
    assert.equal(tick2.code, 10);
    const newComments = tick2.report.deltas.find((d) => d.classes.includes('new-comments'));
    assert.ok(newComments?.enrichment, 'PR #1 new-comments delta must carry real enrichment');
    const firstSeen = tick2.report.deltas.find((d) => d.classes.includes('new'));
    assert.equal(firstSeen?.firstObserved, true, 'PR #2 must be a real firstObserved delta');
    const stale = tick2.report.deltas.find((d) => d.classes.includes('stale'));
    assert.ok(stale?.staleAt, 'issue #10 must go stale after --stale-after 1h unchanged');

    // Tick 3 (T0+3h): PR #2 disappears -> a real `missing` lifecycle delta.
    const tick3 = await runCommand(argv(), {
      fetchPRs: () => ({ rows: [pr1({ conversationComments: 3 })], rateLimit: null }),
      fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
      now: () => T3H,
      env: {},
    });
    assert.equal(tick3.code, 10);
    const missing = tick3.report.deltas.find((d) => d.classes.includes('missing'));
    assert.equal(missing?.to, null, 'PR #2 must be a real missing-lifecycle delta');
    assert.ok(missing?.missingTicks >= 1);

    // A real post-resolution failure, for REPORT_RESULT_FIELDS.error coverage
    // (see test/schema.test.mjs's equivalent fixture for this exact shape).
    const failed = await runCommand(
      ['--repo', REPO, '--monitor-id', MONITOR_ID, '--state-file', stateFile],
      {
        fetchPRs: () => ({ rows: [], rateLimit: null }),
        fetchIssues: () => ({ rows: [], rateLimit: null }),
        readSnapshot: () => {
          throw new Error('invalid snapshot JSON');
        },
        now: () => T3H,
        env: {},
      },
    );
    assert.equal(failed.code, 2);
    assert.ok(failed.report.results[0].error);

    // REPORT_FIELDS: schema v2's envelope is unconditional (contract.mjs's own
    // comment: repos/results/filteredDeltas/warnings are "always present
    // now") -- one real report already covers every field, no union needed.
    assert.deepEqual(Object.keys(tick2.report).sort(), [...REPORT_FIELDS].sort());

    // REPORT_RESULT_FIELDS: `logFile`/`error` are each omitted (never null)
    // when not applicable -- a successful --log tick covers logFile, the
    // failed tick above covers error; together with the common fields they
    // union to exactly the catalog.
    const resultUnion = new Set([
      ...Object.keys(tick2.report.results[0]),
      ...Object.keys(failed.report.results[0]),
    ]);
    assert.deepEqual([...resultUnion].sort(), [...REPORT_RESULT_FIELDS].sort());

    // DELTA_FIELDS: union of every real delta emitted across the ticks above
    // covers every field except none -- each field has a real trigger above
    // (from/to on the ordinary changes, missingTicks on the missing PR,
    // firstObserved on the new PR, seq/summaryLine/details from --log/--detail,
    // enrichment on the commented PR, staleAt on the stale issue).
    const deltaUnion = new Set([
      ...tick2.report.deltas.flatMap((d) => Object.keys(d)),
      ...tick3.report.deltas.flatMap((d) => Object.keys(d)),
    ]);
    assert.deepEqual([...deltaUnion].sort(), [...DELTA_FIELDS].sort());

    // DELTA_SUMMARY_FIELDS: prSummary's real output, exactly as attached by
    // the CLI's own enrichDelta onto a real PR delta's `summary` field --
    // never a call to prSummary() from the test itself.
    const summarizedPr = tick2.report.deltas.find((d) => d.entity === 'pr' && d.to);
    assert.ok(summarizedPr, 'at least one real PR delta must carry an observed to-state');
    assert.deepEqual(Object.keys(summarizedPr.summary).sort(), [...DELTA_SUMMARY_FIELDS].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
