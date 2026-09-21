import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVersionText } from '../lib/version.mjs';

test('version identifies its distribution channel and release URL', () => {
  assert.equal(
    renderVersionText({ name: 'gh-delta', version: '1.2.3' }, 'brew'),
    'gh-delta 1.2.3 (brew) https://github.com/diegomarino/gh-delta/releases\n',
  );
});
