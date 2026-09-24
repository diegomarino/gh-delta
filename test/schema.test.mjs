import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schemaFor } from '../lib/schema.mjs';
import { runCommand } from '../lib/cli.mjs';

// Test-only subset validator for precisely the keywords emitted by schema.mjs.
// `root` is the whole schema document, threaded through recursive calls so a
// `$ref` (e.g. '#/$defs/delta') can be resolved against its own document's
// `$defs`, not just the immediate parent schema fragment.
function resolveRef(root, ref) {
  const path = ref.replace(/^#\//, '').split('/');
  return path.reduce((node, key) => node[key], root);
}
function validates(schema, value, root = schema) {
  if (schema.$ref) return validates(resolveRef(root, schema.$ref), value, root);
  if (schema.allOf && !schema.allOf.every((part) => validates(part, value, root))) return false;
  if (schema.anyOf && !schema.anyOf.some((part) => validates(part, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => validates(part, value, root)).length !== 1)
    return false;
  if (schema.not && validates(schema.not, value, root)) return false;
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
      if (Object.hasOwn(value, key) && !validates(child, value[key], root)) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
    )
      return false;
  }
  return (
    !schema.items ||
    !Array.isArray(value) ||
    value.every((row) => validates(schema.items, row, root))
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

// Structural guardrail: every format's schema document defines its delta
// shape exactly once, under `$defs.delta`, byte-identical across all three
// documents (not three independently maintained copies that merely happen to
// agree), and every place a delta appears is a `$ref` to that one definition
// -- never an inlined/forked properties block. Per-format divergence (json
// requiring from/to; the ndjson delta record adding its `type` discriminator)
// must show up ONLY as an incremental `required`/`properties` layer wrapped
// around the `$ref` via `allOf`, never as a second definition.
test('json/compact/ndjson schemas share one $defs.delta, referenced via $ref', () => {
  const jsonDoc = schemaFor('json');
  const compactDoc = schemaFor('compact');
  const ndjsonDoc = schemaFor('ndjson');

  // The definition itself is byte-identical across all three documents.
  assert.deepEqual(jsonDoc.$defs.delta, compactDoc.$defs.delta);
  assert.deepEqual(jsonDoc.$defs.delta, ndjsonDoc.$defs.delta);
  assert.ok(jsonDoc.$defs.delta.properties.context, 'the shared def carries the real delta shape');

  const jsonDeltaUsage = jsonDoc.oneOf[0].properties.deltas.items;
  const compactDeltaUsage = compactDoc.properties.deltas.items;
  const ndjsonDeltaUsage = ndjsonDoc.oneOf.find(
    (v) => v.allOf?.[1]?.properties?.type?.const === 'delta',
  );

  // Every usage is a $ref to the shared def, not an inlined copy -- no usage
  // may declare its own `properties` for a field the shared def already has.
  for (const usage of [jsonDeltaUsage, compactDeltaUsage, ndjsonDeltaUsage]) {
    assert.ok(Array.isArray(usage.allOf), 'delta usage must be an allOf wrapper around a $ref');
    assert.equal(usage.allOf[0].$ref, '#/$defs/delta');
    assert.equal(usage.properties, undefined, 'no usage may inline its own delta properties');
  }

  // The ONLY axis of divergence is the incremental `required`/`properties`
  // layered on top of the shared $ref.
  assert.deepEqual(jsonDeltaUsage.allOf[1], { required: ['from', 'to'] });
  assert.equal(compactDeltaUsage.allOf[1], undefined);
  assert.deepEqual(ndjsonDeltaUsage.allOf[1], {
    required: ['type'],
    properties: { type: { const: 'delta' } },
  });
});

test('summary schema accepts the full PR shape, the minimal issue shape, and null', () => {
  const summarySchema = schemaFor('json').$defs.delta.properties.summary;
  assert.ok(validates(summarySchema, null));
  assert.ok(validates(summarySchema, summary));
  assert.ok(validates(summarySchema, { state: 'open' }));
});

test('firstObserved (populated, boolean-true-only) and log-only seq are declared but never required', () => {
  const deltaDef = schemaFor('json').$defs.delta;
  assert.ok(deltaDef.properties.firstObserved);
  assert.deepEqual(deltaDef.properties.firstObserved, { const: true });
  assert.ok(deltaDef.properties.seq);
  assert.equal(deltaDef.required.includes('firstObserved'), false);
  assert.equal(deltaDef.required.includes('seq'), false);
  // Also unrequired through every format's actual delta usage (the allOf
  // wrapper only ever adds from/to/type, never these two fields -- seq is
  // populated only when a run uses --log, see lib/cli.mjs).
  for (const format of ['json', 'compact', 'ndjson']) {
    const doc = schemaFor(format);
    const usage =
      format === 'json'
        ? doc.oneOf[0].properties.deltas.items
        : format === 'compact'
          ? doc.properties.deltas.items
          : doc.oneOf.find((v) => v.allOf?.[1]?.properties?.type?.const === 'delta');
    const extraRequired = usage.allOf[1]?.required ?? [];
    assert.equal(extraRequired.includes('firstObserved'), false);
    assert.equal(extraRequired.includes('seq'), false);
  }
});

test('schemas accept representative json, compact and NDJSON records', () => {
  assert.ok(
    validates(schemaFor('json'), {
      schemaVersion: 2,
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
      schemaVersion: 2,
      at: 'now',
      error: 'bad',
      kind: 'config',
      hint: 'fix it',
    }),
  );
  assert.ok(
    validates(schemaFor('json'), { schemaVersion: 2, at: 'now', error: 'bad', kind: 'config' }),
    'schema accepts a bare error without the additive hint',
  );
  assert.ok(
    validates(schemaFor('compact'), {
      schemaVersion: 2,
      repos: ['o/r'],
      detectedAt: 'now',
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
      schemaVersion: 2,
      detectedAt: 'now',
      repos: ['o/r'],
      baseline: false,
      counts: { deltas: 1, byClass: { 'ci-changed': 1 }, filteredDeltas: 0 },
      warnings: [],
      exitCode: 10,
    }),
  );
});
test('schemas reject incomplete, unknown, invalid, and forbidden fixtures', () => {
  assert.equal(validates(schemaFor('json'), { schemaVersion: 2, at: 'now' }), false);
  const base = {
    schemaVersion: 2,
    repos: ['o/r'],
    detectedAt: 'now',
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
      schemaVersion: 2,
      detectedAt: 'now',
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
