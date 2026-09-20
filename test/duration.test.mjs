// Duration tests: the shared grammar must accept exactly one integer + unit
// form and reject everything else, and the error message must name the
// caller's own flag rather than a hardcoded one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../lib/duration.mjs';

test('parseDuration converts each unit to milliseconds', () => {
  assert.deepEqual(parseDuration('90s', { flag: '--since' }), { ms: 90_000 });
  assert.deepEqual(parseDuration('15m', { flag: '--since' }), { ms: 900_000 });
  assert.deepEqual(parseDuration('24h', { flag: '--since' }), { ms: 86_400_000 });
  assert.deepEqual(parseDuration('7d', { flag: '--since' }), { ms: 604_800_000 });
  assert.deepEqual(parseDuration('1s', { flag: '--since' }), { ms: 1000 });
});

test('parseDuration rejects zero and negative values', () => {
  assert.ok(parseDuration('0s', { flag: '--since' }).error);
  assert.ok(parseDuration('-5m', { flag: '--since' }).error);
});

test('parseDuration rejects a bare number with no unit', () => {
  assert.ok(parseDuration('90', { flag: '--since' }).error);
});

test('parseDuration rejects unknown units', () => {
  assert.ok(parseDuration('90x', { flag: '--since' }).error);
  assert.ok(parseDuration('90ms', { flag: '--since' }).error);
});

test('parseDuration rejects empty, null, and undefined input', () => {
  assert.ok(parseDuration('', { flag: '--since' }).error);
  assert.ok(parseDuration(null, { flag: '--since' }).error);
  assert.ok(parseDuration(undefined, { flag: '--since' }).error);
});

test('parseDuration rejects whitespace and floats', () => {
  assert.ok(parseDuration(' 24h', { flag: '--since' }).error);
  assert.ok(parseDuration('24h ', { flag: '--since' }).error);
  assert.ok(parseDuration('1.5h', { flag: '--since' }).error);
});

test('parseDuration error message names the caller-supplied flag', () => {
  assert.match(parseDuration('bogus', { flag: '--since' }).error, /^--since /);
  assert.match(parseDuration('bogus', { flag: '--stale-after' }).error, /^--stale-after /);
  assert.match(parseDuration('bogus', { flag: '--interval' }).error, /^--interval /);
});

test('parseDuration --since error message is byte-identical to the legacy wording', () => {
  assert.equal(
    parseDuration('yesterday', { flag: '--since' }).error,
    '--since must be a positive integer followed by s, m, h, or d (e.g. 24h); got "yesterday"',
  );
});

test('parseDuration without an options object still returns an error result', () => {
  // parseDuration is a published export (gh-delta/duration). An external
  // caller that omits the options object must get the ordinary { error }
  // shape, not a TypeError from destructuring undefined.
  const result = parseDuration('nope');
  assert.ok('error' in result);
  assert.match(result.error, /^duration must be a positive integer/);
  assert.deepEqual(parseDuration('24h'), { ms: 86_400_000 });
});
