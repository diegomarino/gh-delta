// Guard: every report shape the CLI can actually emit must validate against
// its published JSON Schema -- not a hand-picked sample. For the whole
// schema-v2 epic, every ordinary failed tick emitted a report
// (`failedAttempt`'s pre-R6 shape) that violated gh-delta's own schema
// (missing required `repoSource`/`stateFile`), and `test/schema.test.mjs`
// only ever validated success envelopes and the bare pre-flight error --
// never a post-resolution failure -- so `npm run check` stayed green
// throughout.
//
// This is driven from the ERROR_KINDS registry (lib/contract.mjs), not a
// fixed list of kinds copy-pasted here: `KIND_TRIGGERS` must have exactly one
// entry per kind in ERROR_KINDS (checked explicitly below), so adding a new
// error kind without teaching this file how to trigger and validate it fails
// the build -- the one property this guard exists for. `config` is the one
// kind with no per-repo trigger (it is always a pre-flight failure, before
// any repo is resolved -- see lib/schema.mjs's bareError) and is asserted
// against separately for that reason, not omitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { ERROR_KINDS } from '../lib/contract.mjs';
import { schemaFor } from '../lib/schema.mjs';

// A test-only subset validator for precisely the keywords lib/schema.mjs
// emits -- copied from test/schema.test.mjs's own (identically named, not
// shared) helper, since no production or shared-test module exports one.
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

const RATE_LIMIT = { cost: 1, remaining: 9999, resetAt: '2026-01-01T00:00:00.000Z' };
const locks = {
  acquireLock: () => ({ ok: true, token: 'test-lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
};
// Every trigger below resolves a real repo, so a post-resolution failure or
// success alike reaches lib/cli.mjs's registerAttempt -- without this, each
// one would write a persistent breadcrumb into the developer's REAL
// ~/.local/state/gh-delta/registry (env defaults to process.env, which does
// not redirect it) for a state file that never really existed.
const NO_REGISTRY = { GH_DELTA_NO_REGISTRY: '1' };
const T = '2026-01-01T00:00:00.000Z';
const noRows = {
  fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
};

// A pre-existing snapshot (schema v2 item shape) already containing one open
// PR, so a single tick that observes a real change produces a real delta --
// several triggers below need `deltas.length > 0` to exercise their failure
// point (e.g. the durable log is only opened when there is something to log).
function item(fingerprint) {
  return {
    fingerprint,
    context: {},
    meta: { seenAt: T, changedAt: T, ticksSinceChange: 0, missingTicks: 0, staleEmittedFor: null },
  };
}
const EXISTING_SNAPSHOT = {
  pr: { 1: item({ state: 'open', updatedAt: T, isDraft: false }) },
  issue: {},
  meta: {
    schemaVersion: 2,
    ghDeltaVersion: '0.0.0-test',
    repo: 'o/r',
    monitorId: 'm',
    entities: ['pr', 'issue'],
    scope: 'poll',
    horizon: T,
    createdAt: T,
    updatedAt: T,
  },
};
function changedPr() {
  return { number: 1, state: 'open', updatedAt: '2026-01-01T01:00:00.000Z', isDraft: false };
}

// One trigger per ERROR_KINDS entry that is reachable post-resolution (every
// kind except `config`, which is always a pre-flight failure -- see the
// dedicated bareError test below). Each returns `{ argv, deps }` for a single
// real `run()` call that reaches exactly that `results[0].error.kind`.
const KIND_TRIGGERS = {
  snapshot: () => ({
    argv: ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json'],
    deps: {
      ...locks,
      ...noRows,
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON');
      },
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
  github: () => ({
    argv: ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json'],
    deps: {
      ...locks,
      readSnapshot: () => EXISTING_SNAPSHOT,
      fetchPRs: () => {
        throw new Error('gh: connection reset');
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
  io: () => ({
    argv: ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json'],
    deps: {
      acquireLock: () => {
        throw new Error('EACCES: permission denied');
      },
      releaseLock: () => ({ ok: true }),
      assertLockOwned: () => true,
      ...noRows,
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
  busy: () => ({
    argv: ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json'],
    deps: {
      acquireLock: () => ({ ok: false, reason: 'held' }),
      releaseLock: () => ({ ok: true }),
      assertLockOwned: () => true,
      ...noRows,
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
  log: () => ({
    argv: ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json', '--log'],
    deps: {
      ...locks,
      readSnapshot: () => EXISTING_SNAPSHOT,
      writeSnapshotAtomic: () => {},
      fetchPRs: () => ({ rows: [changedPr()], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      appendDeltaLog: () => {
        const err = new Error('log record predates schema v2');
        err.kind = 'log';
        throw err;
      },
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
  'rate-limit': () => ({
    argv: [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/x.json',
      '--rate-limit-floor',
      '100',
    ],
    deps: {
      ...locks,
      ...noRows,
      fetchRateLimit: () => ({ remaining: 10, resetAt: T }),
      now: () => T,
      env: NO_REGISTRY,
    },
  }),
};

test('KIND_TRIGGERS has exactly one entry per reachable ERROR_KINDS member', () => {
  // `config` is the one kind with no per-repo trigger -- see the bareError
  // test below. Any OTHER kind added to ERROR_KINDS without a matching
  // trigger here fails this assertion, not silently passing uncovered.
  const reachable = ERROR_KINDS.filter((kind) => kind !== 'config');
  assert.deepEqual([...reachable].sort(), Object.keys(KIND_TRIGGERS).sort());
});

for (const kind of ERROR_KINDS) {
  if (kind === 'config') continue;
  test(`a real post-resolution "${kind}" failure validates against the json schema`, () => {
    const { argv, deps } = KIND_TRIGGERS[kind]();
    const { code, report } = run(argv, deps);
    assert.equal(report.results[0].error.kind, kind, `must actually trigger kind "${kind}"`);
    assert.ok(
      [1, 2].includes(code),
      `a real error tick must exit transient (1) or permanent (2), got ${code}`,
    );
    assert.ok(validates(schemaFor('json'), report), `"${kind}" failure must validate`);
  });
}

test('a real post-resolution failure validates against the compact and ndjson schemas too', async () => {
  const { argv, deps } = KIND_TRIGGERS.snapshot();
  for (const format of ['compact', 'ndjson']) {
    const result = await runCommand([...argv, '--format', format], deps);
    const records =
      format === 'compact'
        ? [JSON.parse(result.output)]
        : result.output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
    // `errors` is NOT a required property of either schema (a healthy tick
    // legitimately carries none), so schema conformance alone passes just as
    // well on a record that silently dropped the error entirely as on one
    // that carries it -- proven live: neutering compactErrors() to always
    // return undefined left this test green. Assert the error content
    // actually survived the format transformation, not merely that whatever
    // remains is schema-shaped.
    const withErrors = format === 'compact' ? records[0] : records.at(-1);
    assert.ok(
      Array.isArray(withErrors.errors) && withErrors.errors.length > 0,
      `${format}: the triggered error must actually appear in errors[]`,
    );
    assert.equal(
      withErrors.errors[0].kind,
      'snapshot',
      `${format}: errors[0].kind must survive transformation`,
    );
    for (const record of records) assert.ok(validates(schemaFor(format), record));
  }
});

test('the pre-flight config error (bareError, no repo ever resolved) validates against every format', async () => {
  for (const format of ['json', 'compact', 'ndjson']) {
    const result = await runCommand(['--unknown-flag', '--format', format], { now: () => T });
    assert.equal(result.code, 2);
    const records =
      format === 'ndjson'
        ? result.output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [JSON.parse(result.output)];
    for (const record of records) {
      if (format === 'json') assert.equal(record.kind, 'config');
      // Same reasoning as the triggered-failure test above: compact/ndjson's
      // `errors` is optional in the schema, so assert the config error's
      // kind actually made it into errors[], not just that the envelope
      // happens to validate without it.
      if (format !== 'json') {
        assert.ok(Array.isArray(record.errors) && record.errors.length > 0);
        assert.equal(record.errors[0].kind, 'config');
      }
      assert.ok(validates(schemaFor(format), record), `config bareError invalid under ${format}`);
    }
  }
});

test('baseline, real deltas, and a no-change tick each validate against every format, single- and multi-repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-schema-coverage-'));
  try {
    const stateFile = join(dir, 'single.json');
    const argv = (extra = []) => [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      stateFile,
      ...extra,
    ];

    // baseline
    const baseline = await runCommand(argv(), {
      ...noRows,
      now: () => T,
      env: NO_REGISTRY,
    });
    assert.equal(baseline.code, 0);
    assert.ok(validates(schemaFor('json'), baseline.report));

    // real deltas
    const withDeltas = await runCommand(argv(), {
      fetchPRs: () => ({ rows: [changedPr()], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      now: () => '2026-01-01T01:00:00.000Z',
      env: NO_REGISTRY,
    });
    assert.equal(withDeltas.code, 10);
    assert.ok(validates(schemaFor('json'), withDeltas.report));
    // Each format gets its OWN state file and its own baseline -> change tick
    // pair, not a rerun against `stateFile` above: reusing it here once
    // persisted the exact `changedPr()` fingerprint via the json run, so both
    // the compact and ndjson reruns silently observed a no-change tick (0
    // deltas) instead of the real delta this block claims to validate --
    // compact validated only an empty `deltas: []`, and ndjson validated
    // only its `end` record, never a delta record at all. The exit-code and
    // non-empty-deltas assertions below are what make that regress loudly
    // instead of silently, should a future edit reintroduce shared state.
    for (const format of ['compact', 'ndjson']) {
      const formatStateFile = join(dir, `format-${format}.json`);
      const seed = await runCommand(
        ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', formatStateFile],
        { ...noRows, now: () => T, env: NO_REGISTRY },
      );
      assert.equal(seed.code, 0);
      const rendered = await runCommand(
        ['--repo', 'o/r', '--monitor-id', 'm', '--state-file', formatStateFile, '--format', format],
        {
          fetchPRs: () => ({ rows: [changedPr()], rateLimit: RATE_LIMIT }),
          fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
          now: () => '2026-01-01T01:00:00.000Z',
          env: NO_REGISTRY,
        },
      );
      assert.equal(
        rendered.code,
        10,
        `${format}: must observe a real delta, not a stale or no-change tick`,
      );
      const records =
        format === 'compact'
          ? [JSON.parse(rendered.output)]
          : rendered.output
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line));
      const deltaRecords =
        format === 'compact' ? records[0].deltas : records.filter((r) => r.type === 'delta');
      assert.ok(
        deltaRecords.length > 0,
        `${format}: must actually carry at least one delta record to validate`,
      );
      for (const record of records) assert.ok(validates(schemaFor(format), record));
    }

    // no-change tick
    const noChange = await runCommand(argv(), {
      fetchPRs: () => ({ rows: [changedPr()], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      now: () => '2026-01-01T02:00:00.000Z',
      env: NO_REGISTRY,
    });
    assert.equal(noChange.code, 0);
    assert.deepEqual(noChange.report.deltas, []);
    assert.ok(validates(schemaFor('json'), noChange.report));

    // multi-repo, real deltas, in every format. A fresh state-dir with no
    // seeding tick first is a BASELINE (0 deltas, code 0) -- exactly the
    // no-real-content trap this whole file exists to close (see the
    // baseline/no-change tests above): validating only json here also left
    // compact/ndjson's own multi-repo divergence (compactReport deliberately
    // OMITS `baseline` once repos.length > 1 -- see lib/compact-output.mjs)
    // completely unchecked, so a regression making `baseline` required in
    // either agent schema would have passed. Each format gets its own
    // state-dir, seeded first, then a real change tick, with the exit-code
    // and non-empty-deltas assertions that make silently-empty output fail
    // loudly instead of validating a trivial case.
    for (const format of ['json', 'compact', 'ndjson']) {
      const multiStateDir = join(dir, `multi-${format}`);
      const multiArgv = (extra = []) => [
        '--repo',
        'o/one,o/two',
        '--monitor-id',
        'm',
        '--state-dir',
        multiStateDir,
        ...extra,
      ];
      const multiDeps = (rows) => ({
        ...locks,
        fetchPRs: (repo) => ({ rows: repo === 'o/one' ? rows : [], rateLimit: RATE_LIMIT }),
        fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
        env: { GH_DELTA_NO_REGISTRY: '1' },
      });
      const seed = await runCommand(multiArgv(), { ...multiDeps([]), now: () => T });
      assert.equal(seed.code, 0);
      assert.equal(seed.report.results.length, 2);
      const rendered = await runCommand(multiArgv(format === 'json' ? [] : ['--format', format]), {
        ...multiDeps([changedPr()]),
        now: () => '2026-01-01T01:00:00.000Z',
      });
      assert.equal(
        rendered.code,
        10,
        `multi-repo ${format}: must observe a real delta, not a stale or baseline tick`,
      );
      if (format === 'json') {
        assert.equal(rendered.report.results.length, 2);
        assert.equal(rendered.report.deltas.length > 0, true);
        assert.ok(validates(schemaFor('json'), rendered.report));
        continue;
      }
      const records =
        format === 'compact'
          ? [JSON.parse(rendered.output)]
          : rendered.output
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line));
      const envelope = format === 'compact' ? records[0] : records.at(-1); // ndjson's `end` record
      assert.equal(
        Object.hasOwn(envelope, 'baseline'),
        false,
        `${format}: must omit baseline for a >1 repo report, per compactReport`,
      );
      const deltaRecords =
        format === 'compact' ? records[0].deltas : records.filter((r) => r.type === 'delta');
      assert.ok(
        deltaRecords.length > 0,
        `${format}: multi-repo tick must actually carry a delta record to validate`,
      );
      for (const record of records) assert.ok(validates(schemaFor(format), record));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
