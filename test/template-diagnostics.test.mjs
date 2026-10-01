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
