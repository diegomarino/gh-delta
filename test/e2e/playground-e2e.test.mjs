// Playground e2e helper tests: keep the live harness logic predictable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeltaClass,
  defaultPlaygroundRepoName,
  detectorResultFromProcess,
  parseRepoSpec,
  safeRunId,
  shouldDeletePlaygroundRepo,
} from './playground-e2e-helpers.mjs';

test('parseRepoSpec accepts owner/name and plain repo names', () => {
  assert.deepEqual(parseRepoSpec('owner/repo', 'me'), { owner: 'owner', name: 'repo' });
  assert.deepEqual(parseRepoSpec('repo-only', 'me'), { owner: 'me', name: 'repo-only' });
});

test('safeRunId strips characters unsafe for GitHub names', () => {
  assert.equal(safeRunId('2026-07-02T17:53:20.789Z'), '2026-07-02T17-53-20-789Z');
});

test('defaultPlaygroundRepoName creates an ephemeral test repo name', () => {
  assert.equal(
    defaultPlaygroundRepoName('2026-07-02T17-53-20-789Z'),
    'gh-delta-test-playground-2026-07-02T17-53-20-789Z',
  );
});

test('shouldDeletePlaygroundRepo deletes only harness-created repos unless kept', () => {
  assert.equal(shouldDeletePlaygroundRepo({ createdByHarness: true, keepRepo: false }), true);
  assert.equal(shouldDeletePlaygroundRepo({ createdByHarness: true, keepRepo: true }), false);
  assert.equal(shouldDeletePlaygroundRepo({ createdByHarness: false, keepRepo: false }), false);
});

test('assertDeltaClass requires exit 10 and the expected class', () => {
  const report = {
    deltas: [
      { entity: 'issue', number: 7, classes: ['new-comments'] },
      { entity: 'pr', number: 2, classes: ['merged'] },
    ],
  };

  assert.doesNotThrow(() => assertDeltaClass({ code: 10, report }, 'issue', 7, 'new-comments'));
  assert.throws(
    () => assertDeltaClass({ code: 0, report }, 'issue', 7, 'new-comments'),
    /expected gh-delta exit 10/,
  );
  assert.throws(
    () => assertDeltaClass({ code: 10, report }, 'issue', 7, 'relabeled'),
    /missing expected delta/,
  );
});

test('detectorResultFromProcess accepts gh-delta exit 10 as a parsed result', () => {
  const result = detectorResultFromProcess({
    code: 10,
    stdout: JSON.stringify({ deltas: [{ entity: 'issue', number: 1, classes: ['new'] }] }),
  });

  assert.equal(result.code, 10);
  assert.equal(result.report.deltas[0].classes[0], 'new');
});
