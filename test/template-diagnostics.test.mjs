import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTemplateDiagnostics } from '../lib/template-diagnostics.mjs';

test('formatTemplateDiagnostics escapes DEL and U+2028 inside JSON strings', () => {
  const stderr = formatTemplateDiagnostics({
    error: `bad\u007F\u2028path`,
    kind: 'config',
    hint: 'Fix the template.',
  });
  assert.match(stderr, /^gh-delta: error \{/);
  assert.match(stderr, /\\u007f/);
  assert.match(stderr, /\\u2028/);
  assert.equal(stderr.includes('\u2028'), false);
  assert.equal(stderr.includes('\u007F'), false);
});

test('template diagnostics match NDJSON suppression and preserve warning occurrence order', async () => {
  const { formatOmitEndDiagnostics } = await import('../lib/omit-end-diagnostics.mjs');
  const a = { label: 'A', reason: 'a' };
  const b = { label: 'B', reason: 'b' };
  const report = {
    results: [
      {
        repo: 'o/r',
        error: {
          kind: 'rate-limit',
          message: 'retry\n\u2029',
          hint: 'later',
          resetAt: 'now',
          remaining: 0,
          cost: 2,
        },
      },
    ],
    warnings: [a, b, a],
  };
  assert.equal(formatTemplateDiagnostics(report, [a, b]), formatOmitEndDiagnostics(report, [a, b]));
  assert.deepEqual(
    formatTemplateDiagnostics(report, [a, b])
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line.slice('gh-delta: warning '.length)).label),
    ['A', 'B', 'A'],
  );
});
