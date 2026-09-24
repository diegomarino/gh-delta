// Delta identity tests: every delta carries a deterministic, content-addressed
// `id` so downstream consumers dedupe idempotently on one field. The id keys on
// the observed state (`to.fingerprint`) for cross-monitor idempotency and falls
// back to `from.fingerprint`+classes+missingTicks for the to-null missing
// lifecycle. Schema v2: `to`/`from` are full snapshot items
// (`{ fingerprint, context, meta }`, see lib/snapshot.mjs); the id hashes only
// the `fingerprint` section, with no drop-list -- context/meta never enter it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Tests must never leave breadcrumbs in the developer's real run registry.
process.env.GH_DELTA_NO_REGISTRY = '1';
import { run } from '../lib/cli.mjs';
import { detectDeltas } from '../lib/detect.mjs';
import { buildOutpostPayload } from '../lib/outpost.mjs';
import { deltaId, deltaIdentity, prFingerprint } from '../lib/fingerprint.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

// Wrap a bare fingerprint fragment into the three-section snapshot item shape.
const item = (fingerprint, meta = {}) => ({
  fingerprint,
  context: {},
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
    ...meta,
  },
});

const basePr = {
  number: 42,
  title: 'add widget',
  state: 'open',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  checks: [],
  reviewDecision: 'review_required',
  reviews: [],
  mergeable: 'unknown',
  conversationComments: 0,
  reviewComments: 0,
  headSha: 'sha1',
};

// The prior-snapshot fingerprint the detector already holds for PR 42 (OPEN).
const openFp = prFingerprint(basePr);

// Same lock-stub rationale as test/cli.test.mjs: this suite is about delta
// identity, not lock behavior, and every run() call below shares the literal
// state-file path '/tmp/x.json' -- a real fs-backed lock there would race
// against other test files running concurrently.
const NOOP_LOCK_DEPS = {
  acquireLock: () => ({ ok: true, token: 'test-lock-token' }),
  releaseLock: () => ({ ok: true, released: true }),
  assertLockOwned: () => true,
};

// Schema v2 snapshot-wide meta is mandatory (lib/snapshot.mjs); stamp a
// default onto any hand-built `existing` fixture that omits it.
const DEFAULT_OLD_META = {
  schemaVersion: 2,
  ghDeltaVersion: '0.0.0-test',
  repo: 'o/r',
  monitorId: 'main',
  entities: ['pr', 'issue'],
  scope: 'poll',
  horizon: '2026-07-01T11:00:00.000Z',
  createdAt: '2026-07-01T11:00:00.000Z',
  updatedAt: '2026-07-01T11:00:00.000Z',
};

// Minimal `run()` harness mirroring test/cli.test.mjs: no disk, no network.
// `stored` persists across successive run() calls so the missing lifecycle can
// advance tick by tick.
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };

function deps(prSeq, { existing = null } = {}) {
  let stored = existing && !existing.meta ? { ...existing, meta: DEFAULT_OLD_META } : existing;
  return {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({ rows: prSeq.shift(), rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => stored,
    writeSnapshotAtomic: (_p, d) => {
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
  };
}

// The persisted snapshot shape run()/readSnapshot expects: a map of
// three-section items, not bare fingerprints.
const seedPr = (fingerprint = openFp) => ({ pr: { 42: item(fingerprint) }, issue: {} });

const ARGV = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];

// ---------------------------------------------------------------------------
// Pure identity / hash properties
// ---------------------------------------------------------------------------

test('deltaId is a 64-char lowercase hex string', () => {
  const id = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['new'],
      from: null,
      to: item(openFp),
    }),
  );
  assert.match(id, HEX64);
});

test('deltaId is canonicalization order-independent (spec 5)', () => {
  const ordered = { state: 'open', updatedAt: 't', comments: 3, head: 'sha' };
  const shuffled = { head: 'sha', comments: 3, updatedAt: 't', state: 'open' };
  const a = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: item(ordered),
    }),
  );
  const b = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: item(shuffled),
    }),
  );
  assert.equal(a, b);
});

test('deltaIdentity keys on `to.fingerprint` when the entity was observed, verbatim (no drop-list)', () => {
  const identity = deltaIdentity('o/r', {
    entity: 'pr',
    number: 42,
    classes: ['ci-changed'],
    from: item({ state: 'open' }),
    to: item(
      {
        state: 'open',
        checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
        reviews: [],
      },
      { missingTicks: 0 },
    ),
  });
  assert.deepEqual(identity, {
    repo: 'o/r',
    entity: 'pr',
    number: 42,
    to: {
      state: 'open',
      checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
      reviews: [],
    },
  });
});

test('deltaIdentity keys on `from.fingerprint`+classes+missingTicks when `to` is null', () => {
  const identity = deltaIdentity('o/r', {
    entity: 'pr',
    number: 42,
    classes: ['still-missing'],
    missingTicks: 2,
    from: item({ state: 'open' }, { missingTicks: 1 }),
    to: null,
  });
  assert.deepEqual(identity, {
    repo: 'o/r',
    entity: 'pr',
    number: 42,
    from: { state: 'open' },
    classes: ['still-missing'],
    missingTicks: 2,
  });
});

test('different `to` states yield different ids (spec 3)', () => {
  const merged = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['merged'],
      from: item(openFp),
      to: item({ ...openFp, state: 'merged' }),
    }),
  );
  const closed = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['closed'],
      from: item(openFp),
      to: item({ ...openFp, state: 'closed' }),
    }),
  );
  assert.notEqual(merged, closed);
});

test('the three missing stages get distinct ids via classes+missingTicks (spec 4)', () => {
  const mk = (classes, ticks) =>
    deltaId(
      deltaIdentity('o/r', {
        entity: 'pr',
        number: 42,
        classes,
        missingTicks: ticks,
        from: item(openFp, { missingTicks: ticks - 1 }),
        to: null,
      }),
    );
  const missing = mk(['missing'], 1);
  const still = mk(['still-missing'], 2);
  const gone = mk(['presumed-deleted'], 3);
  // The `fingerprint` base is identical across stages (missing bookkeeping
  // lives in `meta`, never in `fingerprint`); distinctness must come purely
  // from classes+ticks.
  assert.equal(new Set([missing, still, gone]).size, 3);
});

test('deltaId over a fingerprint with an injected threads entry differs from the id without it', () => {
  // Schema v2: there is no drop-list. `threads` is an ordinary fingerprint
  // field like any other, so it enters the delta id like everything else here.
  const withThreads = {
    ...openFp,
    threads: [{ id: 'T_A', resolved: false }],
  };
  const without = { ...openFp };
  const a = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: item(withThreads),
    }),
  );
  const b = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: item(without),
    }),
  );
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// End-to-end through run(): every emitted delta carries a stable id
// ---------------------------------------------------------------------------

test('every emitted delta carries a 64-char hex id', () => {
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const { report } = run(ARGV, deps([[merged]], { existing: seedPr() }));
  assert.ok(report.deltas.length > 0);
  for (const delta of report.deltas) assert.match(delta.id, HEX64);
});

test('the same change in two separate runs yields identical ids (spec 1)', () => {
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const r1 = run(ARGV, deps([[merged]], { existing: clone(seedPr()) }));
  const r2 = run(ARGV, deps([[merged]], { existing: clone(seedPr()) }));
  assert.equal(r1.report.deltas[0].id, r2.report.deltas[0].id);
});

test('the same change under two different monitor ids yields identical ids (spec 2)', () => {
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const argv = (id) => ['--repo', 'o/r', '--monitor-id', id, '--state-file', '/tmp/x.json'];
  const r1 = run(argv('m1'), deps([[merged]], { existing: clone(seedPr()) }));
  const r2 = run(argv('m2'), deps([[merged]], { existing: clone(seedPr()) }));
  assert.notEqual(r1.report.monitorId, r2.report.monitorId);
  assert.equal(r1.report.deltas[0].id, r2.report.deltas[0].id);
});

test('id is present and stable for each delta family (spec 4)', () => {
  const cases = {
    // new: PR absent from a non-baseline snapshot, then observed
    new: { existing: { pr: {}, issue: {} }, fetch: { ...basePr } },
    // updated: only updatedAt churns
    updated: {
      existing: seedPr(),
      fetch: { ...basePr, updatedAt: '2026-07-01T11:00:00Z' },
    },
    // ci-changed: only the CI rollup differs
    'ci-changed': {
      existing: seedPr(),
      fetch: {
        ...basePr,
        checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
      },
    },
  };
  const ids = {};
  for (const [family, { existing, fetch }] of Object.entries(cases)) {
    const r1 = run(ARGV, deps([[fetch]], { existing: clone(existing) }));
    const r2 = run(ARGV, deps([[fetch]], { existing: clone(existing) }));
    const delta = r1.report.deltas.find((d) => d.classes.includes(family));
    assert.ok(delta, `expected a ${family} delta`);
    assert.match(delta.id, HEX64);
    assert.equal(
      delta.id,
      r2.report.deltas.find((d) => d.classes.includes(family)).id,
      `${family} id must be stable`,
    );
    ids[family] = delta.id;
  }
  // distinct observed states must not collide
  assert.equal(new Set(Object.values(ids)).size, Object.keys(ids).length);
});

test('id for a plain open->merged transition matches the schema-v2 golden value', () => {
  // Regression pin (hard constraint 1): once set, this id must not drift.
  // Schema v2 F1 intentionally changed this again from R2's golden value:
  // F1 split the aggregate `comments` field into `conversationComments` and
  // `reviewComments`, which changes every hash `to.fingerprint` feeds.
  const merged = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['merged'],
      from: item(openFp),
      to: item({ ...openFp, state: 'merged' }),
    }),
  );
  assert.equal(merged, '5ef58d4dbcd64d6ecc88f8890053ea7e712718f5fe55c9366c7f9c13b7252d50');
});

test('missing -> still-missing -> presumed-deleted produce three distinct stable ids (spec 4)', () => {
  const d = deps([[], [], []], { existing: seedPr() });
  const ids = [];
  const seenClasses = [];
  for (let i = 0; i < 3; i++) {
    const { report } = run(ARGV, d);
    ids.push(report.deltas[0].id);
    seenClasses.push(report.deltas[0].classes[0]);
  }
  assert.deepEqual(seenClasses, ['missing', 'still-missing', 'presumed-deleted']);
  for (const id of ids) assert.match(id, HEX64);
  assert.equal(new Set(ids).size, 3);
});

// The documented programmatic embedding path (docs/usage.md) pairs detectDeltas
// with buildOutpostPayload directly, bypassing run(). Deltas from detectDeltas
// are not id-stamped (detect.mjs is repo-agnostic), so buildOutpostPayload must
// compute the id itself rather than emit id: null.
test('buildOutpostPayload stamps id for a delta taken straight from detectDeltas', () => {
  const old = seedPr();
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const { deltas } = detectDeltas(old, { pr: [merged], issue: [] }, { at: '2026-07-01T11:00:00Z' });
  const delta = deltas[0];
  assert.equal(delta.id, undefined); // repo-agnostic detector never assigns id
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'm', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.match(payload.delta.id, HEX64);
  assert.equal(payload.delta.id, deltaId(deltaIdentity('o/r', delta)));
});
