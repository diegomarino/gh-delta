// Text formatter tests: operator-facing output stays readable without a second bin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTextOutput } from '../lib/text-output.mjs';

const issueDelta = {
  entity: 'issue',
  number: 17,
  title: 'Backfill customer imports',
  classes: ['relabeled'],
  line: 'ISSUE #17 "Backfill customer imports": relabeled',
};

const prDelta = {
  entity: 'pr',
  number: 42,
  title: 'Add billing webhook',
  classes: ['ci-changed', 'review-changed'],
  line: 'PR #42 "Add billing webhook": ci-changed, review-changed',
};

test('baseline text output prints a heartbeat and baseline note', () => {
  const output = formatTextOutput({
    code: 0,
    report: {
      baseline: true,
      repo: 'owner/repo',
      monitorId: 'watch',
      at: '2026-07-01T10:00:00.000Z',
      deltas: [],
      summary: 'baseline established: 1 PRs, 2 issues',
    },
    now: () => '2026-07-01T10:00:00.000Z',
  });

  assert.match(output, /2026-07-01T10:00:00.000Z \| 0 delta\(s\)/);
  assert.match(output, /Baseline seeded for owner\/repo \(monitor: watch\)/);
});

test('delta text output prints each delta with suggested action', () => {
  const output = formatTextOutput({
    code: 10,
    report: {
      baseline: false,
      repo: 'owner/repo',
      monitorId: 'watch',
      at: '2026-07-01T10:05:00.000Z',
      deltas: [
        prDelta,
        issueDelta,
        {
          entity: 'pr',
          number: 8,
          title: '(missing from current fetch)',
          classes: ['still-missing'],
          line: 'PR #8 "(missing from current fetch)": still-missing',
        },
        {
          entity: 'pr',
          number: 9,
          title: 'Refactor queue worker',
          classes: ['unresolved-threads-added'],
          line: 'PR #9 "Refactor queue worker": unresolved-threads-added',
        },
      ],
      summary: '4 delta(s)',
    },
    now: () => '2026-07-01T10:05:00.000Z',
  });

  assert.match(output, /2026-07-01T10:05:00.000Z \| 4 delta\(s\)/);
  assert.match(output, /PR #42 "Add billing webhook"/);
  assert.match(output, /suggested action: CI\/review changed/);
  assert.match(output, /ISSUE #17 "Backfill customer imports"/);
  assert.match(output, /suggested action: scope\/state changed/);
  assert.match(output, /PR #8 "\(missing from current fetch\)"/);
  assert.match(output, /suggested action: object is still absent/);
  assert.match(output, /PR #9 "Refactor queue worker"/);
  assert.match(output, /suggested action: unresolved review threads/);
});

test('error text output reports snapshot-preserving failure', () => {
  const output = formatTextOutput({
    code: 1,
    report: {
      error: 'gh: API rate limit exceeded',
      repo: 'owner/repo',
      monitorId: 'watch',
      at: '2026-07-01T10:10:00.000Z',
    },
    now: () => '2026-07-01T10:10:00.000Z',
  });

  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /gh: API rate limit exceeded/);
  assert.match(output, /Snapshot was not updated/);
});
