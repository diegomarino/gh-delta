// Delta identity tests: every delta carries a deterministic, content-addressed
// `id` so downstream consumers dedupe idempotently on one field. The id keys on
// the observed state (`to`) for cross-monitor idempotency and falls back to
// `from`+classes+missingTicks for the to-null missing lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/cli.mjs';
import { detectDeltas } from '../lib/detect.mjs';
import { buildOutpostPayload } from '../lib/outpost.mjs';
import { deltaId, deltaIdentity, prFingerprint } from '../lib/fingerprint.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

const basePr = {
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'sha1',
};

// The prior-snapshot fingerprint the detector already holds for PR 42 (OPEN).
const openFp = prFingerprint(basePr);

// Minimal `run()` harness mirroring test/cli.test.mjs: no disk, no network.
// `stored` persists across successive run() calls so the missing lifecycle can
// advance tick by tick.
function deps(prSeq, { existing = null } = {}) {
  let stored = existing;
  return {
    fetchPRs: () => prSeq.shift(),
    fetchIssues: () => [],
    readSnapshot: () => stored,
    writeSnapshotAtomic: (_p, d) => {
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
  };
}

const ARGV = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];

// ---------------------------------------------------------------------------
// Pure identity / hash properties
// ---------------------------------------------------------------------------

test('deltaId is a 64-char lowercase hex string', () => {
  const id = deltaId(
    deltaIdentity('o/r', { entity: 'pr', number: 42, classes: ['new'], from: null, to: openFp }),
  );
  assert.match(id, HEX64);
});

test('deltaId is canonicalization order-independent (spec 5)', () => {
  const ordered = { state: 'OPEN', updatedAt: 't', comments: 3, head: 'sha' };
  const shuffled = { head: 'sha', comments: 3, updatedAt: 't', state: 'OPEN' };
  const a = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: ordered,
    }),
  );
  const b = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['updated'],
      from: null,
      to: shuffled,
    }),
  );
  assert.equal(a, b);
});

test('deltaIdentity keys on `to` (comparable) when the entity was observed', () => {
  const identity = deltaIdentity('o/r', {
    entity: 'pr',
    number: 42,
    classes: ['ci-changed'],
    from: { state: 'OPEN' },
    // churn fields must be stripped so identity is stable
    to: { state: 'OPEN', missing: false, missingTicks: 0, commentsOverflow: false },
  });
  assert.deepEqual(identity, { repo: 'o/r', entity: 'pr', number: 42, to: { state: 'OPEN' } });
});

test('deltaIdentity keys on `from`+classes+missingTicks when `to` is null', () => {
  const identity = deltaIdentity('o/r', {
    entity: 'pr',
    number: 42,
    classes: ['still-missing'],
    missingTicks: 2,
    from: { state: 'OPEN', missing: true, missingTicks: 1 },
    to: null,
  });
  assert.deepEqual(identity, {
    repo: 'o/r',
    entity: 'pr',
    number: 42,
    from: { state: 'OPEN' },
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
      from: openFp,
      to: { ...openFp, state: 'MERGED' },
    }),
  );
  const closed = deltaId(
    deltaIdentity('o/r', {
      entity: 'pr',
      number: 42,
      classes: ['closed'],
      from: openFp,
      to: { ...openFp, state: 'CLOSED' },
    }),
  );
  assert.notEqual(merged, closed);
});

test('the three missing stages get distinct ids via classes+missingTicks (spec 4)', () => {
  const mk = (classes, ticks, fromExtra) =>
    deltaId(
      deltaIdentity('o/r', {
        entity: 'pr',
        number: 42,
        classes,
        missingTicks: ticks,
        from: { ...openFp, ...fromExtra },
        to: null,
      }),
    );
  const missing = mk(['missing'], 1, {});
  const still = mk(['still-missing'], 2, { missing: true, missingTicks: 1 });
  const gone = mk(['presumed-deleted'], 3, { missing: true, missingTicks: 2 });
  // comparableFingerprint strips the missing bookkeeping, so the `from` base is
  // identical across stages; distinctness must come purely from classes+ticks.
  assert.equal(new Set([missing, still, gone]).size, 3);
});

// ---------------------------------------------------------------------------
// End-to-end through run(): every emitted delta carries a stable id
// ---------------------------------------------------------------------------

test('every emitted delta carries a 64-char hex id', () => {
  const merged = { ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' };
  const { report } = run(
    ARGV,
    deps([[merged]], { existing: { pr: { 42: clone(openFp) }, issue: {} } }),
  );
  assert.ok(report.deltas.length > 0);
  for (const delta of report.deltas) assert.match(delta.id, HEX64);
});

test('the same change in two separate runs yields identical ids (spec 1)', () => {
  const merged = { ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' };
  const seed = () => ({ pr: { 42: clone(openFp) }, issue: {} });
  const r1 = run(ARGV, deps([[merged]], { existing: seed() }));
  const r2 = run(ARGV, deps([[merged]], { existing: seed() }));
  assert.equal(r1.report.deltas[0].id, r2.report.deltas[0].id);
});

test('the same change under two different monitor ids yields identical ids (spec 2)', () => {
  const merged = { ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' };
  const seed = () => ({ pr: { 42: clone(openFp) }, issue: {} });
  const argv = (id) => ['--repo', 'o/r', '--monitor-id', id, '--state-file', '/tmp/x.json'];
  const r1 = run(argv('m1'), deps([[merged]], { existing: seed() }));
  const r2 = run(argv('m2'), deps([[merged]], { existing: seed() }));
  assert.notEqual(r1.report.monitorId, r2.report.monitorId);
  assert.equal(r1.report.deltas[0].id, r2.report.deltas[0].id);
});

test('id is present and stable for each delta family (spec 4)', () => {
  const cases = {
    // new: PR absent from a non-baseline snapshot, then observed
    new: { existing: { pr: {}, issue: {} }, fetch: { ...basePr } },
    // updated: only updatedAt churns
    updated: {
      existing: { pr: { 42: clone(openFp) }, issue: {} },
      fetch: { ...basePr, updatedAt: '2026-07-01T11:00:00Z' },
    },
    // ci-changed: only the CI rollup differs
    'ci-changed': {
      existing: { pr: { 42: clone(openFp) }, issue: {} },
      fetch: {
        ...basePr,
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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

test('missing -> still-missing -> presumed-deleted produce three distinct stable ids (spec 4)', () => {
  const d = deps([[], [], []], { existing: { pr: { 42: clone(openFp) }, issue: {} } });
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
  const old = { pr: { 42: clone(openFp) }, issue: {} };
  const merged = { ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' };
  const { deltas } = detectDeltas(old, { pr: [merged], issue: [] });
  const delta = deltas[0];
  assert.equal(delta.id, undefined); // repo-agnostic detector never assigns id
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'm', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.match(payload.id, HEX64);
  assert.equal(payload.id, deltaId(deltaIdentity('o/r', delta)));
});
