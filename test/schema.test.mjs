import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schemaFor } from '../lib/schema.mjs';
import { runCommand } from '../lib/cli.mjs';

// Test-only subset validator for precisely the keywords emitted by schema.mjs.
function validates(schema, value) {
  if (schema.anyOf && !schema.anyOf.some((part) => validates(part, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => validates(part, value)).length !== 1)
    return false;
  if (schema.not && validates(schema.not, value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  const matches = (type) =>
    (type === 'null' && value === null) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'integer' && Number.isInteger(value));
  if (types.length && !types.some(matches)) return false;
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (schema.minItems !== undefined && value.length < schema.minItems) return false;
  if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) return false;
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties))
      if (Object.hasOwn(value, key) && !validates(child, value[key])) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
    )
      return false;
  }
  return (
    !schema.items || !Array.isArray(value) || value.every((row) => validates(schema.items, row))
  );
}
const summary = {
  ciRollup: 'green',
  reviewDecision: 'approved',
  mergeable: 'mergeable',
  mergeStateStatus: 'clean',
  state: 'open',
  isDraft: false,
  unresolvedReviewThreads: 0,
  headSha: 'a'.repeat(40),
};
const context = { id: 'gid', title: 'title', url: 'https://github.com/o/r/pull/1', author: 'a' };
const delta = {
  id: 'x',
  repo: 'o/r',
  entity: 'pr',
  number: 1,
  context,
  classes: ['ci-changed'],
  summary,
  changed: {},
  from: {},
  to: {},
};

const result = {
  repo: 'o/r',
  baseline: false,
  repoSource: 'flag',
  stateFile: '/tmp/state.json',
  rateLimit: null,
};

test('runtime schemas equal published artifacts', () => {
  for (const format of ['json', 'compact', 'ndjson'])
    assert.deepEqual(
      JSON.parse(readFileSync(new URL(`../schema/${format}.json`, import.meta.url), 'utf8')),
      schemaFor(format),
    );
});

// Structural guardrail: the three formats' delta schemas share one property
// set for every field except the one deliberate per-format rename
// (`details` in json, `detail` in compact/ndjson) and json/compact's own
// `type` discriminator on the ndjson delta variant.
test('json/compact/ndjson delta schemas share one common property set', () => {
  const jsonDelta = schemaFor('json').oneOf[0].properties.deltas.items;
  const compactDelta = schemaFor('compact').properties.deltas.items;
  const ndjsonDelta = schemaFor('ndjson').oneOf.find((v) => v.properties.type?.const === 'delta');

  const shared = (obj) => {
    const { details: _details, detail: _detail, type: _type, ...rest } = obj.properties;
    return rest;
  };
  assert.deepEqual(shared(jsonDelta), shared(compactDelta));
  assert.deepEqual(shared(jsonDelta), shared(ndjsonDelta));

  // json requires from/to; compact/ndjson make them optional (present only
  // under --full).
  assert.ok(jsonDelta.required.includes('from'));
  assert.ok(jsonDelta.required.includes('to'));
  assert.equal(compactDelta.required.includes('from'), false);
  assert.equal(ndjsonDelta.required.includes('from'), false);
});

test('summary schema accepts the full PR shape, the minimal issue shape, and null', () => {
  const summarySchema = schemaFor('json').oneOf[0].properties.deltas.items.properties.summary;
  assert.ok(validates(summarySchema, null));
  assert.ok(validates(summarySchema, summary));
  assert.ok(validates(summarySchema, { state: 'open' }));
});

test('reserved firstObserved/seq fields are declared but never required', () => {
  const jsonDelta = schemaFor('json').oneOf[0].properties.deltas.items;
  assert.ok(jsonDelta.properties.firstObserved);
  assert.ok(jsonDelta.properties.seq);
  assert.equal(jsonDelta.required.includes('firstObserved'), false);
  assert.equal(jsonDelta.required.includes('seq'), false);
});

test('schemas accept representative json, compact and NDJSON records', () => {
  assert.ok(
    validates(schemaFor('json'), {
      schemaVersion: 1,
      detectedAt: 'now',
      monitorId: 'm',
      entities: ['pr'],
      repos: ['o/r'],
      results: [result],
      deltas: [delta],
      filteredDeltas: 0,
      warnings: [],
      summary: '1 delta(s)',
    }),
  );
  assert.ok(
    validates(schemaFor('json'), {
      schemaVersion: 1,
      at: 'now',
      error: 'bad',
      kind: 'config',
      hint: 'fix it',
    }),
  );
  assert.ok(
    validates(schemaFor('json'), { schemaVersion: 1, at: 'now', error: 'bad', kind: 'config' }),
    'schema accepts a bare error without the additive hint',
  );
  assert.ok(
    validates(schemaFor('compact'), {
      schemaVersion: 1,
      repos: ['o/r'],
      at: 'now',
      baseline: false,
      counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
      deltas: [delta],
      warnings: [],
    }),
  );
  assert.ok(validates(schemaFor('ndjson'), { type: 'delta', ...delta }));
  assert.ok(
    validates(schemaFor('ndjson'), {
      type: 'end',
      schemaVersion: 1,
      at: 'now',
      repos: ['o/r'],
      baseline: false,
      counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
      warnings: [],
      exitCode: 10,
    }),
  );
});
test('schemas reject incomplete, unknown, invalid, and forbidden fixtures', () => {
  assert.equal(validates(schemaFor('json'), { schemaVersion: 1, at: 'now' }), false);
  const base = {
    schemaVersion: 1,
    repos: ['o/r'],
    at: 'now',
    baseline: false,
    counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
    deltas: [delta],
    warnings: [],
  };
  assert.equal(
    validates(schemaFor('compact'), {
      ...base,
      counts: { deltas: 1, byClass: { unknown: 1 }, filteredDeltas: 0 },
    }),
    false,
  );
  assert.equal(
    validates(schemaFor('compact'), {
      ...base,
      deltas: [{ ...delta, summary: { ...summary, ciRollup: 'bad' } }],
    }),
    false,
  );
  assert.equal(
    validates(schemaFor('ndjson'), {
      type: 'end',
      schemaVersion: 1,
      at: 'now',
      repos: ['o/r'],
      counts: { deltas: 0, byClass: {}, filteredDeltas: 0 },
      warnings: [],
    }),
    false,
  );
});

test('early repository-free compact and NDJSON errors validate without undefined fields', async () => {
  const compact = await runCommand(['--unknown', '--format', 'compact'], { now: () => 'now' });
  const compactReport = JSON.parse(compact.output);
  assert.equal(Object.hasOwn(compactReport, 'repo'), false);
  assert.equal(Object.hasOwn(compactReport, 'repos'), false);
  assert.ok(validates(schemaFor('compact'), compactReport));

  const ndjson = await runCommand(['--unknown', '--format', 'ndjson'], { now: () => 'now' });
  const end = JSON.parse(ndjson.output);
  assert.equal(Object.hasOwn(end, 'repo'), false);
  assert.equal(Object.hasOwn(end, 'repos'), false);
  assert.ok(validates(schemaFor('ndjson'), end));
});
