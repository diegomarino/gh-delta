import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { compactReport } from '../lib/compact-output.mjs';

test('structured errors always carry a useful recovery hint', () => {
  // `not-a-repo` is a pre-flight config error (bare shape, hint at the top);
  // the fetch failure is discovered after the repo is known, so its hint
  // lives inside its own results[] entry.
  const bare = run(['--repo', 'not-a-repo']);
  assert.equal(typeof bare.report.hint, 'string');
  assert.ok(bare.report.hint.length > 12);

  const enveloped = run(['--repo', 'o/r'], {
    fetchPRs: () => {
      throw new Error('network down');
    },
  });
  const hint = enveloped.report.results[0].error.hint;
  assert.equal(typeof hint, 'string');
  assert.ok(hint.length > 12);
});

test('agent error envelopes retain the recovery hint', () => {
  const compact = compactReport({
    schemaVersion: 2,
    at: 'now',
    error: 'bad',
    kind: 'config',
    hint: 'fix it',
    deltas: [],
  });
  assert.equal(compact.errors[0].hint, 'fix it');
});
