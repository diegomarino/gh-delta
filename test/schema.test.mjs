import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schemaFor } from '../lib/schema.mjs';

test('runtime schemas are deterministic and equal published artifacts', () => {
  for (const format of ['json', 'compact', 'ndjson']) {
    assert.deepEqual(
      JSON.parse(readFileSync(new URL(`../schema/${format}.json`, import.meta.url), 'utf8')),
      schemaFor(format),
    );
  }
  assert.throws(() => schemaFor('text'), /format/);
});
