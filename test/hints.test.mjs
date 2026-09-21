import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { compactReport } from '../lib/compact-output.mjs';

test('structured errors always carry a useful recovery hint', () => {
  const cases = [
    run(['--repo', 'not-a-repo']),
    run(['--repo', 'o/r'], {
      fetchPRs: () => {
        throw new Error('network down');
      },
    }),
  ];
  for (const result of cases) {
    assert.equal(typeof result.report.hint, 'string');
    assert.ok(result.report.hint.length > 12);
  }
});

test('agent error envelopes retain the recovery hint', () => {
  const compact = compactReport({
    schemaVersion: 1,
    at: 'now',
    error: 'bad',
    kind: 'config',
    hint: 'fix it',
    deltas: [],
  });
  assert.equal(compact.errors[0].hint, 'fix it');
});
