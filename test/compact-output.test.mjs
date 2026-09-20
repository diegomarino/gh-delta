import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactReport, ndjsonReport } from '../lib/compact-output.mjs';

const delta = {
  id: 'x',
  repo: 'o/r',
  entity: 'pr',
  number: 7,
  title: 'Fix',
  classes: ['ci-changed'],
  from: { state: 'OPEN', ciChecks: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] },
  to: { ciChecks: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }], state: 'OPEN' },
  details: [{ class: 'ci-changed' }],
  summaryLine: 'legacy',
};

test('compactReport emits self-contained agent deltas only', () => {
  const value = compactReport(
    { schemaVersion: 1, repo: 'o/r', at: 'now', baseline: false, deltas: [delta] },
    10,
    [],
    { detail: true },
  );
  assert.deepEqual(value, {
    schemaVersion: 1,
    repo: 'o/r',
    at: 'now',
    baseline: false,
    counts: { deltas: 1, byClass: { 'ci-changed': 1 } },
    deltas: [
      {
        id: 'x',
        repo: 'o/r',
        entity: 'pr',
        number: 7,
        title: 'Fix',
        url: 'https://github.com/o/r/pull/7',
        classes: ['ci-changed'],
        summary: {
          ciRollup: 'green',
          reviewDecision: 'none',
          mergeable: 'unknown',
          mergeStateStatus: 'unknown',
          state: 'open',
          isDraft: false,
          unresolvedReviewThreads: 0,
          headSha: '',
        },
        changed: { ci: { from: 'failed', to: 'green' }, ciChecks: { fixed: ['lint'] } },
        detail: [{ class: 'ci-changed' }],
      },
    ],
  });
});

test('ndjsonReport ends with an end record and newline', () => {
  const output = ndjsonReport(
    { schemaVersion: 1, repo: 'o/r', at: 'now', baseline: false, deltas: [delta] },
    10,
    [],
  );
  const lines = output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'delta');
  assert.deepEqual(lines[1], {
    type: 'end',
    schemaVersion: 1,
    at: 'now',
    repo: 'o/r',
    baseline: false,
    counts: { deltas: 1, byClass: { 'ci-changed': 1 } },
    exitCode: 10,
  });
  assert.ok(output.endsWith('\n'));
});

test('a representative compact ci change without detail stays bounded', () => {
  const report = compactReport(
    { schemaVersion: 1, repo: 'o/r', at: 'now', baseline: false, deltas: [delta] },
    10,
  );
  assert.ok(JSON.stringify(report.deltas[0]).length <= 600);
  assert.equal(Object.hasOwn(report.deltas[0], 'detail'), false);
});
