// CLI contract tests: exit codes, snapshot safety, and user-facing detail output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

// Tests must never leave breadcrumbs in the developer's real run registry.
process.env.GH_DELTA_NO_REGISTRY = '1';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { outpostSignature } from '../lib/outpost.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { DELTA_DETAIL_FIELDS_BY_CLASS } from '../lib/contract.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
  comments: 0,
  headSha: 'sha1',
};

// Schema v2 snapshot item shape: `{ fingerprint, context, meta }` (see
// lib/snapshot.mjs). Wraps a bare fingerprint fragment (often built by
// prFingerprint) into the shape a persisted snapshot map now stores.
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

// The prior-tick fingerprint most `existing` snapshot fixtures below start
// from: PR 42 at rest, matching a fresh fetch of `basePr` (empty CI rollup,
// empty reviews, no labels/assignees/reviewRequests, etc). Deviating fixtures
// build their own via `prFingerprint({ ...basePr, ...overrides })` instead.
const openFp = prFingerprint(basePr);

test('outpostSignature matches the published HMAC-SHA256 known vector', () => {
  assert.equal(
    outpostSignature('The quick brown fox jumps over the lazy dog', 'key'),
    'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
});

test('postOutpost signs the exact serialized body with the configured HMAC secret', async () => {
  const { postOutpost } = await import('../lib/outpost.mjs');
  const payload = { type: 'gh-delta.delta', title: 'snowman ☃' };
  let sent;

  await postOutpost('https://example.com/hook', payload, {
    secret: 'Jefe',
    fetchImpl: async (_url, options) => {
      sent = options;
      return { ok: true, status: 202 };
    },
  });

  const expectedBody = '{"type":"gh-delta.delta","title":"snowman ☃"}';
  assert.equal(sent.body, expectedBody, 'the signed bytes must be the bytes sent');
  assert.equal(
    sent.headers['X-GhDelta-Signature'],
    `sha256=${createHmac('sha256', 'Jefe').update(expectedBody, 'utf8').digest('hex')}`,
  );
});

test('--outpost-secret validates its environment-variable name before repo derivation', () => {
  let derived = false;
  const { code, report } = run(['--outpost-secret', 'not-valid'], {
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      derived = true;
      throw new Error('must not derive');
    },
  });

  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-secret must name an environment variable/);
  assert.equal(derived, false);
});

test('--outpost-secret reads the injected environment and does not leak its value', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item({
          state: 'open',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'x',
          review: 'review_required',
          reviews: 'x',
          mergeable: 'unknown',
          comments: 0,
          head: 'sha1',
        }),
      },
      issue: {},
    },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  let sent;
  d.env = { OUTPOST_SECRET: 'not-in-report' };
  d.outpostFetch = async (_url, options) => {
    sent = options;
    return { ok: true, status: 202 };
  };

  const result = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
      '--outpost-secret',
      'OUTPOST_SECRET',
    ],
    d,
  );

  assert.match(sent.headers['X-GhDelta-Signature'], /^sha256=[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /not-in-report/);
  assert.doesNotMatch(sent.body, /not-in-report/);
});

test('--outpost-secret requires an outpost URL and a non-empty injected value', () => {
  const missingUrl = run(['--repo', 'o/r', '--outpost-secret', 'OUTPOST_SECRET'], {
    now: () => '2026-07-01T12:00:00Z',
    env: { OUTPOST_SECRET: 'value' },
  });
  assert.equal(missingUrl.code, 2);
  assert.match(missingUrl.report.error, /requires --outpost-url/);

  const emptyValue = run(
    ['--repo', 'o/r', '--outpost-url', 'https://example.com', '--outpost-secret', 'OUTPOST_SECRET'],
    { now: () => '2026-07-01T12:00:00Z', env: { OUTPOST_SECRET: '' } },
  );
  assert.equal(emptyValue.code, 2);
  assert.match(emptyValue.report.error, /OUTPOST_SECRET.*unset or empty/);
});

test('unsigned postOutpost keeps the legacy headers and body bytes', async () => {
  const { postOutpost } = await import('../lib/outpost.mjs');
  let sent;
  await postOutpost(
    'https://example.com/hook',
    { a: 1 },
    {
      fetchImpl: async (_url, options) => {
        sent = options;
        return { ok: true, status: 202 };
      },
    },
  );
  assert.deepEqual(sent.headers, { 'Content-Type': 'application/json' });
  assert.equal(sent.body, '{"a":1}');
});

// This suite is about detector behavior, not lock behavior (see
// test/lock.test.mjs and test/cli-lock.test.mjs for that) -- and many tests
// below intentionally share literal state-file paths (e.g. /tmp/x.json)
// across independent runs. A real fs-backed lock at that shared path would
// make cross-file test parallelism racy. Every deps() object here stubs the
// lock as an always-uncontended no-op so run() exercises the full lock
// call sequence (acquire -> fence -> release) without ever touching disk.
const NOOP_LOCK_DEPS = {
  acquireLock: () => ({ ok: true, token: 'test-lock-token' }),
  releaseLock: () => ({ ok: true, released: true }),
  assertLockOwned: () => true,
};

// Every fetcher's real (lib/gh.mjs) return shape is `{ rows, rateLimit }`.
// Most tests here don't care about the quota number, so this is the shared
// default a mocked fetch gets unless a test overrides `fetchRateLimit`/the
// fetcher itself to assert on it (see the accumulation tests near
// --rate-limit-floor and the "tick accumulates" test below).
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };

// Schema v2 snapshot-wide meta is mandatory (lib/snapshot.mjs). Most
// `existing` fixtures below only care about pr/issue contents, so `deps()`
// stamps a valid default meta onto any `existing` snapshot that doesn't
// already carry one -- letting horizonCutoff/writeSnapshotAtomic's meta
// bookkeeping proceed without every fixture spelling out the full shape.
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

function deps(prSeq, { existing = null } = {}) {
  let writes = 0;
  let stored = existing && !existing.meta ? { ...existing, meta: DEFAULT_OLD_META } : existing;
  let readPath;
  let writePath;
  return {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({ rows: prSeq.shift(), rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: (p) => {
      readPath = p;
      return stored;
    },
    writeSnapshotAtomic: (p, d) => {
      writes++;
      writePath = p;
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
    get writes() {
      return writes;
    },
    get stored() {
      return stored;
    },
    get readPath() {
      return readPath;
    },
    get writePath() {
      return writePath;
    },
  };
}

test('first run returns code 0 (baseline) and writes the snapshot', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.baseline, true);
  assert.equal(report.monitorId, 'main');
  assert.deepEqual(report.entities, ['pr', 'issue']);
  assert.equal(d.writes, 1);
});

test('error reports carry schemaVersion and omit deltas', () => {
  const d = deps([[basePr]]);
  d.resolveRepo = () => ({ status: 'declined' });
  const { code, report } = run(['--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.equal(report.schemaVersion, 1);
  assert.match(report.error, /--repo/);
  assert.equal(report.deltas, undefined);
  assert.equal(d.writes, 0);
});

test('watch add derives only a local repository and defaults monitor/state paths', () => {
  let calls = 0;
  const result = run(['watch', 'add', 'pr:42', '--until', 'merged'], {
    now: () => '2026-07-01T12:00:00Z',
    defaultMonitor: () => 'local',
    resolveLocalRepo: () => {
      calls++;
      return { status: 'found', repo: 'o/r' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.code, 0);
  assert.match(result.report.watchDir, /watch-o%2Fr__local\.d$/);
});

test('eligible PR-only watch uses the economical fetch and separate explicit state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-economical-watch-'));
  for (const number of [3, 9]) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  const d = deps([[]]);
  let targeted;
  d.fetchPRsByNumber = (_repo, numbers, options) => {
    targeted = { numbers, options };
    return { rows: numbers.map((number) => ({ ...basePr, number })), rateLimit: RATE_LIMIT };
  };
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run for an eligible watch');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/economical.json',
      '--watch-dir',
      dir,
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(targeted.numbers, [3, 9]);
  assert.equal(targeted.options.onProgress instanceof Function, true);
  assert.equal(result.report.stateFile, '/tmp/economical.json.watch.json');
  assert.equal(d.readPath, '/tmp/economical.json.watch.json');
  assert.equal(d.writePath, '/tmp/economical.json.watch.json');
  assert.deepEqual(Object.keys(d.stored.pr), ['3', '9']);
});

test('empty eligible watch makes no GitHub calls and snapshots an empty PR universe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-empty-economical-watch-'));
  const d = deps([[]]);
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchIssues = () => {
    throw new Error('issue fetch must not run');
  };
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run for empty watch');
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/empty-economical.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.stateFile, '/tmp/empty-economical.json.watch.json');
  assert.deepEqual(d.stored.pr, {});
  assert.deepEqual(d.stored.issue, {});
});

test('ineligible watch lists retain broad fetch and ordinary state history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-broad-watch-'));
  for (let number = 1; number <= 11; number++) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  const d = deps([[basePr]]);
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run for 11 watches');
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/broad-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.stateFile, '/tmp/broad-watch.json');
  assert.equal(d.readPath, '/tmp/broad-watch.json');
});

test('removing a watch projects old economical state without a missing delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-project-watch-'));
  writeFileSync(
    join(dir, 'pr-3.json'),
    JSON.stringify({ entity: 'pr', number: 3, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([], {
    existing: {
      pr: {
        3: item(prFingerprint({ ...basePr, number: 3 })),
        9: item(prFingerprint({ ...basePr, number: 9 })),
      },
      issue: {},
    },
  });
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr, number: 3 }], rateLimit: RATE_LIMIT });
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/project-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
  assert.deepEqual(Object.keys(d.stored.pr), ['3']);
});

test('a null alias for a still-watched PR enters the normal missing lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-null-watch-'));
  writeFileSync(
    join(dir, 'pr-3.json'),
    JSON.stringify({ entity: 'pr', number: 3, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([], {
    existing: { pr: { 3: item(prFingerprint({ ...basePr, number: 3 })) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [], rateLimit: RATE_LIMIT });
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/null-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.classes),
    [['missing']],
  );
});

test('economical watch logs derive from the selected state identity for explicit and derived paths', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-log-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const runEconomical = (stateArgs) => {
    const d = deps([], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
    d.fetchPRsByNumber = () => ({
      rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
      rateLimit: RATE_LIMIT,
    });
    let appended;
    d.appendDeltaLog = (file) => {
      appended = file;
    };
    d.removeWatchUnchanged = () => false;
    const result = run(['--repo', 'o/r', '--watch-dir', watch, '--log', ...stateArgs], d);
    return { result, appended };
  };
  const explicit = runEconomical(['--state-file', '/tmp/economical-log.json']);
  assert.equal(explicit.result.report.stateFile, '/tmp/economical-log.json.watch.json');
  assert.equal(
    explicit.result.report.logFile,
    '/tmp/economical-log.json.watch.json.deltalog.ndjson',
  );
  assert.equal(explicit.appended, explicit.result.report.logFile);

  const derived = runEconomical(['--state-dir', '/tmp/economical-log-state']);
  assert.match(derived.result.report.stateFile, /__watch-pr\.json$/);
  assert.equal(derived.result.report.logFile, `${derived.result.report.stateFile}.deltalog.ndjson`);
  assert.equal(derived.appended, derived.result.report.logFile);
});

test('--entities issue makes a PR-only watch list retain normal full-fetch state', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-issue-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([[]]);
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run without PR entity selection');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--entities',
      'issue',
      '--state-file',
      '/tmp/issue-watch.json',
      '--watch-dir',
      watch,
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.stateFile, '/tmp/issue-watch.json');
  assert.deepEqual(d.stored.pr, {});
  assert.deepEqual(d.stored.issue, {});
});

test('economical run registers PR-only watch identity and scope', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-reg-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([[]]);
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  d.env = { GH_DELTA_REGISTRY_DIR: '/tmp/economical-registry' };
  run(['--repo', 'o/r', '--state-file', '/tmp/economical-reg.json', '--watch-dir', watch], d);
  assert.deepEqual(registered[0].entities, ['pr']);
  assert.equal(registered[0].scope, 'watch-pr');
  assert.equal(registered[0].stateFile, '/tmp/economical-reg.json.watch.json');
});

test('watch add local derivation decline is config without GitHub fetches', () => {
  let fetched = false;
  const result = run(['watch', 'add', 'pr:42', '--until', 'merged'], {
    resolveLocalRepo: () => ({ status: 'declined' }),
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(fetched, false);
});

test('watch commands reject wrong positional cardinality before mutation', () => {
  for (const argv of [
    ['watch', 'add', '--until', 'merged', '--watch-dir', '/tmp/nope'],
    ['watch', 'rm', 'pr:1', 'pr:2', '--watch-dir', '/tmp/nope'],
    ['watch', 'ls', 'pr:1', '--watch-dir', '/tmp/nope'],
  ]) {
    const result = run(argv, {
      resolveLocalRepo: () => {
        throw new Error('unused');
      },
    });
    assert.equal(result.code, 2);
    assert.match(result.report.error, /requires exactly/);
  }
});

test('watch cleanup failure warns after snapshot publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-cleanup-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  writeFileSync(
    join(watch, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  d.removeWatchUnchanged = () => {
    throw new Error('unlink denied');
  };
  const { code, warnings } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.ok(
    warnings.some(
      (warning) => warning.label === 'watch cleanup' && /unlink denied/.test(warning.reason),
    ),
  );
});

test('ignored merged terminal delta keeps its watch entry while snapshot advances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-ignore-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  let cleanup = false;
  d.removeWatchUnchanged = () => {
    cleanup = true;
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(code, 0);
  assert.deepEqual(report.deltas, []);
  assert.equal(report.filteredDeltas, 1);
  assert.equal(d.writes, 1);
  assert.equal(cleanup, false);
  assert.ok(readFileSync(entry, 'utf8'));
});

test('watch text commands render watch-specific output, never detector deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-text-'));
  for (const argv of [
    ['watch', 'add', 'pr:42', '--until', 'merged', '--watch-dir', dir, '--format', 'text'],
    ['watch', 'ls', '--watch-dir', dir, '--format', 'text'],
    ['watch', 'rm', 'pr:42', '--watch-dir', dir, '--format', 'text'],
  ]) {
    const result = await runCommand(argv);
    assert.doesNotMatch(result.output, /delta\(s\)/);
    assert.match(result.output, /watch/);
  }
});

test('--state-dir derives a monitor-scoped snapshot path', () => {
  const d = deps([[basePr]]);
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'prs-fast', '--state-dir', '/tmp/state', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(d.readPath, '/tmp/state/repo-o%2Fr__monitor-prs-fast__pr.json');
  assert.equal(d.writePath, '/tmp/state/repo-o%2Fr__monitor-prs-fast__pr.json');
});

test('a delta returns code 10 and rewrites the snapshot', () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 10);
  assert.ok(report.deltas.some((x) => x.classes.includes('merged')));
});

test('no change returns code 0 and still refreshes snapshot', () => {
  const seed = { pr: {}, issue: {} };
  const d = deps([[]], { existing: seed });
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
});

test('a gh failure returns code 1 and does NOT write the snapshot', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({ pr: {}, issue: {}, meta: DEFAULT_OLD_META }),
    writeSnapshotAtomic: () => {
      throw new Error('should not be called');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 1);
});

// A prior tick's fingerprint that predates the `checks[]` field entirely (a
// legacy snapshot written before schema v2's row-level check tracking) --
// exercises the opaque ci-changed fallback -- but which is otherwise a real
// prFingerprint() output, so every other compared field (baseRef, labels,
// assignees, reviewRequests, mergeStateStatus, thread bookkeeping) already
// matches what a fresh fetch of `basePr` would produce.
function opaqueCiFixture() {
  const fp = prFingerprint({ ...basePr, updatedAt: '2026-07-01T10:00:00Z' });
  delete fp.checks;
  return fp;
}

test('--summary-line attaches only the human summary line to each delta', () => {
  const d = deps([[{ ...basePr, comments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: { 42: item(opaqueCiFixture()) },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--summary-line'],
    d,
  );
  assert.equal(report.deltas[0].summaryLine, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(report.deltas[0].line, undefined);
  assert.equal(report.deltas[0].details, undefined);
});

test('--detail keeps line compatibility and adds structured class details', () => {
  const d = deps([[{ ...basePr, comments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: { 42: item(opaqueCiFixture()) },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const delta = report.deltas[0];
  assert.equal(delta.line, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(delta.summaryLine, delta.line);
  assert.deepEqual(delta.details, [
    {
      class: 'ci-changed',
      field: 'checks',
      from: null,
      to: [],
      opaque: true,
    },
    {
      class: 'new-comments',
      field: 'comments',
      from: 0,
      to: 2,
      delta: 2,
      opaque: true,
    },
  ]);
});

test('--detail explains the audit-driven classes: set diffs, base transition, comment removal', () => {
  const before = {
    ...basePr,
    comments: 3,
    baseRef: 'main',
    assignees: ['alice'],
    reviewRequests: [],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    comments: 2,
    baseRef: 'release/2.0',
    assignees: ['bob'],
    reviewRequests: ['carol', 'org/platform-team'],
  };
  const d = deps([[after]], {
    existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const delta = report.deltas[0];
  for (const klass of [
    'comments-removed',
    'base-changed',
    'assignees-changed',
    'review-requests-changed',
  ]) {
    assert.ok(delta.classes.includes(klass), `expected class ${klass}`);
  }
  const details = delta.details;
  assert.deepEqual(
    details.find((row) => row.class === 'comments-removed'),
    {
      class: 'comments-removed',
      field: 'comments',
      from: 3,
      to: 2,
      delta: -1,
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'base-changed'),
    {
      class: 'base-changed',
      field: 'baseRef',
      from: 'main',
      to: 'release/2.0',
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'assignees-changed'),
    {
      class: 'assignees-changed',
      field: 'assignees',
      added: ['bob'],
      removed: ['alice'],
    },
  );
  assert.deepEqual(
    details.find((row) => row.class === 'review-requests-changed'),
    {
      class: 'review-requests-changed',
      field: 'reviewRequests',
      added: ['carol', 'org/platform-team'],
      removed: [],
    },
  );
});

test('--detail names the added and removed thread ids for a same-count thread swap (P2-1)', () => {
  // The swap case this feature exists for: totals are unchanged (one thread
  // resolves while another reopens), so pushNumericDelta returns nothing for
  // unresolvedReviewThreads. Without a dedicated thread-identity detail row,
  // `--detail` would name nothing at all for either class.
  const before = {
    ...basePr,
    threads: [
      { id: 'RT_1', resolved: false },
      { id: 'RT_2', resolved: true },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    threads: [
      { id: 'RT_1', resolved: true },
      { id: 'RT_2', resolved: false },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('unresolved-threads-added'));
  assert.ok(delta.classes.includes('unresolved-threads-resolved'));

  const addedRow = delta.details.find(
    (row) => row.class === 'unresolved-threads-added' && row.field === 'threads',
  );
  const resolvedRow = delta.details.find(
    (row) => row.class === 'unresolved-threads-resolved' && row.field === 'threads',
  );
  assert.ok(addedRow, 'unresolved-threads-added must name the swap even though the count held');
  assert.ok(
    resolvedRow,
    'unresolved-threads-resolved must name the swap even though the count held',
  );
  assert.deepEqual(addedRow.added, ['RT_2']);
  assert.deepEqual(addedRow.removed, ['RT_1']);
  assert.deepEqual(resolvedRow.added, ['RT_2']);
  assert.deepEqual(resolvedRow.removed, ['RT_1']);

  // The numeric row is genuinely absent: the count did not move.
  assert.ok(!delta.details.some((row) => row.field === 'unresolvedReviewThreads'));
});

test('--detail does not leak threads into generic updated rows (P2-2)', () => {
  // Head SHA and thread states change in the same tick: `threads` differs
  // between from/to, but its meaningful expression is the dedicated `threads`
  // row on unresolved-threads-*, not a generic `updated` field row (which the
  // exported contract does not declare for the `updated` class).
  const before = {
    ...basePr,
    headSha: 'sha1',
    threads: [
      { id: 'RT_1', resolved: false },
      { id: 'RT_2', resolved: true },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    threads: [
      { id: 'RT_1', resolved: true },
      { id: 'RT_2', resolved: false },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('updated'));
  assert.ok(delta.classes.includes('head-changed'));

  const updatedFields = delta.details
    .filter((row) => row.class === 'updated')
    .map((row) => row.field);
  assert.ok(!updatedFields.includes('threads'));

  // Every emitted key must fall within the declared contract for its class.
  for (const row of delta.details) {
    const allowed = DELTA_DETAIL_FIELDS_BY_CLASS[row.class];
    assert.ok(allowed, `no field map for class "${row.class}"`);
    if (!['presence', 'unknown'].includes(row.field)) {
      assert.ok(
        allowed.includes(row.field),
        `field "${row.field}" not declared for class "${row.class}"`,
      );
    }
  }
});

test('--detail names the exact checks and reviews that changed when the snapshot carries summaries', () => {
  const before = {
    ...basePr,
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
      { name: 'docs', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
    reviewDecision: 'changes_requested',
    reviews: [
      {
        id: 'r1',
        submittedAt: '2026-07-01T09:00:00Z',
        author: 'alice',
        state: 'changes_requested',
        commit: 'c1',
      },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      { name: 'lint', kind: 'check', status: 'in_progress', conclusion: '' },
    ],
    reviewDecision: 'approved',
    reviews: [
      {
        id: 'r2',
        submittedAt: '2026-07-01T10:30:00Z',
        author: 'alice',
        state: 'approved',
        commit: 'c2',
      },
      {
        id: 'r3',
        submittedAt: '2026-07-01T10:31:00Z',
        author: 'bob',
        state: 'commented',
        commit: 'c2',
      },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  assert.equal(code, 10);
  const details = report.deltas[0].details;

  const ci = details.find((row) => row.class === 'ci-changed');
  assert.equal(ci.opaque, undefined);
  assert.deepEqual(ci.added, [
    { name: 'lint', kind: 'check', status: 'in_progress', conclusion: '' },
  ]);
  assert.deepEqual(ci.removed, [
    { name: 'docs', kind: 'check', status: 'completed', conclusion: 'success' },
  ]);
  assert.deepEqual(ci.changed, [
    {
      name: 'build',
      from: { kind: 'check', status: 'completed', conclusion: 'failure' },
      to: { kind: 'check', status: 'completed', conclusion: 'success' },
    },
  ]);

  // Reviews are keyed by `id` (always present in schema v2, unlike author,
  // which collides whenever the same person reviews more than once): a new
  // review from the same author on approval is a distinct id, not an
  // in-place "changed" row.
  const reviews = details.find((row) => row.field === 'reviews');
  assert.equal(reviews.opaque, undefined);
  assert.deepEqual(reviews.added, [
    {
      id: 'r2',
      author: 'alice',
      state: 'approved',
      submittedAt: '2026-07-01T10:30:00Z',
      commit: 'c2',
    },
    {
      id: 'r3',
      author: 'bob',
      state: 'commented',
      submittedAt: '2026-07-01T10:31:00Z',
      commit: 'c2',
    },
  ]);
  assert.deepEqual(reviews.removed, [
    {
      id: 'r1',
      author: 'alice',
      state: 'changes_requested',
      submittedAt: '2026-07-01T09:00:00Z',
      commit: 'c1',
    },
  ]);
  assert.deepEqual(reviews.changed, []);
  const decision = details.find((row) => row.field === 'reviewDecision');
  assert.deepEqual(decision, {
    class: 'review-changed',
    field: 'reviewDecision',
    from: 'changes_requested',
    to: 'approved',
  });
});

test('--detail falls back to opaque when duplicate check names would collapse the diff', () => {
  // Two rollup rows can share a name (e.g. a CheckRun and a StatusContext).
  // Keying the diff by name would silently drop the removed failing `build`
  // row and misreport `lint` as the only change, so the detail must refuse to
  // name the breakdown instead.
  const before = {
    ...basePr,
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' },
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
  };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      { name: 'build', kind: 'check', status: 'completed', conclusion: 'success' },
      { name: 'lint', kind: 'check', status: 'completed', conclusion: 'success' },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const ci = report.deltas[0].details.find((row) => row.class === 'ci-changed');
  assert.equal(ci.opaque, true);
  assert.equal(ci.added, undefined);
  assert.equal(ci.removed, undefined);
  assert.equal(ci.changed, undefined);
});

const SUMMARIES_ARGS = [
  '--repo',
  'o/r',
  '--monitor-id',
  'main',
  '--state-file',
  '/tmp/x.json',
  '--summaries',
];

test('--summaries acceptance: posting a successful status makes summary.ciRollup green', () => {
  // A PR with zero checks, re-observed after a successful commit status lands on
  // the head: a ci-changed delta whose semantic summary reports the CI as green.
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('ci-changed'), 'the status transition is a ci-changed delta');
  assert.deepEqual(delta.summary, {
    ciRollup: 'green',
    reviewDecision: 'review_required',
    mergeable: 'unknown',
    mergeStateStatus: 'unknown',
    state: 'open',
    isDraft: false,
    unresolvedReviewThreads: 0,
    headSha: 'sha1',
  });
});

test('--summaries surfaces mergeStateStatus behind for an up-to-date-required branch', () => {
  // A PR that GitHub reports mergeable yet BEHIND its base (repos requiring the
  // branch be up to date): the summary must expose that distinctly so a consumer
  // does not emit a false "ready to merge".
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    mergeStateStatus: 'behind',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  assert.equal(report.deltas[0].summary.mergeStateStatus, 'behind');
});

test('a mergeStateStatus-only transition fires an updated delta end-to-end', () => {
  // Base branch advanced: the same PR goes CLEAN -> BEHIND with nothing else
  // changed. gh-delta must emit a delta (exit 10) carrying the new summary, or a
  // consumer never re-evaluates merge readiness.
  const before = { ...basePr, mergeStateStatus: 'clean' };
  const after = { ...basePr, mergeStateStatus: 'behind' };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['updated']);
  assert.equal(report.deltas[0].summary.mergeStateStatus, 'behind');
});

const BASELINE_EMIT_ARGS = [
  '--repo',
  'o/r',
  '--monitor-id',
  'main',
  '--state-file',
  '/tmp/x.json',
  '--baseline-emit-state',
];

test('--baseline-emit-state off: baseline stays exit 0 with empty deltas', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.baseline, true);
  assert.deepEqual(report.deltas, []);
});

test('--baseline-emit-state on: baseline exits 10 with baseline:true and non-empty deltas', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(BASELINE_EMIT_ARGS, d);
  assert.equal(code, 10);
  assert.equal(report.baseline, true);
  assert.equal(report.deltas.length, 1);
  const delta = report.deltas[0];
  assert.deepEqual(delta.classes, ['baseline-state']);
  assert.equal(delta.from, null);
  assert.equal(delta.to.fingerprint.state, 'open');
  assert.match(delta.id, /^[0-9a-f]{64}$/);
});

test('--baseline-emit-state ids are stable across a re-baseline over unchanged state', () => {
  // Fresh state both times (readSnapshot returns null), same observed PR: the
  // content-addressed id must match so idempotent consumers dedupe for free.
  const first = run(BASELINE_EMIT_ARGS, deps([[basePr]]));
  const second = run(BASELINE_EMIT_ARGS, deps([[basePr]]));
  assert.equal(first.report.deltas[0].id, second.report.deltas[0].id);
});

test('--baseline-emit-state composes with --summaries (PR baseline-state carries a summary)', () => {
  const d = deps([[basePr]]);
  const { code, report } = run([...BASELINE_EMIT_ARGS, '--summaries'], d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.equal(delta.classes[0], 'baseline-state');
  assert.equal(delta.summary.state, 'open');
  assert.equal(delta.summary.mergeStateStatus, 'unknown');
});

test('--help-json advertises --baseline-emit-state', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { report } = run(['--help-json'], d);
  const help = JSON.parse(report);
  assert.ok(help.options.some((o) => o.name === '--baseline-emit-state'));
});

test('--summaries acceptance: a PR that lost its checks reports ciRollup none, not green', () => {
  const before = {
    ...basePr,
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const after = { ...basePr, updatedAt: '2026-07-01T11:00:00Z', checks: [] };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(SUMMARIES_ARGS, d);
  assert.equal(code, 10);
  const delta = report.deltas[0];
  assert.ok(delta.classes.includes('ci-changed'));
  assert.equal(delta.summary.ciRollup, 'none');
});

test('--summaries is purely additive: delta.id and every other field are byte-identical', () => {
  const before = { ...basePr, checks: [] };
  const after = {
    ...basePr,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/deploy', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const seed = () => ({ pr: { 42: item(prFingerprint(before)) }, issue: {} });
  const baseArgs = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];
  const withFlag = run([...baseArgs, '--summaries'], deps([[after]], { existing: seed() })).report
    .deltas[0];
  const without = run(baseArgs, deps([[after]], { existing: seed() })).report.deltas[0];
  // The opaque fingerprints already sit in `to`; the only difference the flag makes
  // is the extra sibling `summary` key. Same content-addressed id, same everything else.
  assert.equal(withFlag.id, without.id);
  assert.equal('summary' in without, false, 'without the flag there is no summary field');
  const { summary, ...withFlagRest } = withFlag;
  assert.ok(summary, 'the flag adds a summary');
  assert.deepEqual(withFlagRest, without);
});

const FILTER_ARGS = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];

test('--ignore-authors suppresses fully covered bot comments but advances the snapshot', () => {
  const before = {
    ...basePr,
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'GitHub-Actions[bot]' },
    ],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const result = run([...FILTER_ARGS, '--ignore-authors', 'github-actions[bot]'], d);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
  assert.equal(result.report.filteredDeltas, 1);
  assert.equal(d.stored.pr['42'].fingerprint.comments, 2);
});

test('--ignore-authors fails open and --detail is opaque for an unusable new comment row', () => {
  const before = {
    ...basePr,
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: null, author: null },
    ],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const filtered = run(
    [...FILTER_ARGS, '--ignore-authors', 'human'],
    deps([[after]], { existing }),
  );
  assert.equal(filtered.code, 10);
  assert.ok(filtered.report.deltas[0].classes.includes('new-comments'));
  assert.equal(filtered.report.filteredDeltas, 0);
  const detailed = run([...FILTER_ARGS, '--detail'], deps([[after]], { existing })).report
    .deltas[0];
  const comments = detailed.details.find((row) => row.class === 'new-comments');
  assert.equal(comments.opaque, true);
  assert.equal(comments.added, undefined);
});

test('--ignore-authors and --detail fail open when PR aggregate comments include non-conversation rows', () => {
  const before = {
    ...basePr,
    comments: 4,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    comments: 5,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'github-actions[bot]' }],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const filtered = run(
    [...FILTER_ARGS, '--ignore-authors', 'github-actions[bot]'],
    deps([[after]], { existing }),
  );
  assert.equal(filtered.code, 10);
  assert.ok(filtered.report.deltas[0].classes.includes('new-comments'));
  const detailed = run([...FILTER_ARGS, '--detail'], deps([[after]], { existing })).report
    .deltas[0];
  const comments = detailed.details.find((row) => row.class === 'new-comments');
  assert.equal(comments.opaque, true);
  assert.equal(comments.added, undefined);
});

test('class filters run before ignored authors and filteredDeltas excludes surviving class removal', () => {
  const before = {
    ...basePr,
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'github-actions[bot]' },
    ],
  };
  const result = run(
    [
      ...FILTER_ARGS,
      '--only-classes',
      'new-comments',
      '--ignore-classes',
      'ci-changed',
      '--ignore-authors',
      'github-actions[bot]',
    ],
    deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } }),
  );
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].classes, ['head-changed', 'updated']);
  assert.equal(result.report.filteredDeltas, 0);
});

test('--detail explains check, review, and comment identity metadata carried in the fingerprint', () => {
  // Schema v2: ciDetails/reviewDetails/commentNodes/conversationComments are
  // ordinary `fingerprint` fields now (no more hideInternalDetails gate), so
  // they are always present in `to`/`from`, with or without --detail. What
  // --detail adds is the structured, named breakdown in `details`.
  const before = {
    ...basePr,
    checks: [
      {
        name: 'build',
        kind: 'check',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://ci/old',
      },
    ],
    reviews: [
      {
        id: 'R1',
        submittedAt: '2026-07-01T09:00:00Z',
        author: 'alice',
        state: 'approved',
        commit: 'a',
      },
    ],
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C0', author: 'human' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [
      {
        name: 'build',
        kind: 'check',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: 'https://ci/build',
      },
    ],
    reviews: [
      {
        id: 'R2',
        submittedAt: '2026-07-01T10:00:00Z',
        author: 'alice',
        state: 'changes_requested',
        commit: 'b',
      },
    ],
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C0', author: 'human' },
      { id: 'C1', author: 'bot' },
    ],
  };
  const existing = { pr: { 42: item(prFingerprint(before)) }, issue: {} };
  const plain = run(FILTER_ARGS, deps([[after]], { existing })).report.deltas[0];
  assert.equal(JSON.stringify(plain).includes('https://ci/build'), true);
  assert.equal(JSON.stringify(plain).includes('R2'), true);
  assert.equal(JSON.stringify(plain).includes('C1'), true);
  const detailed = run([...FILTER_ARGS, '--detail'], deps([[after]], { existing })).report
    .deltas[0];
  assert.equal(
    detailed.details.find((row) => row.field === 'checks').changed[0].to.detailsUrl,
    'https://ci/build',
  );
  // Reviews are keyed by id (always present): R1 -> R2 on the same PR is a
  // distinct review, so it surfaces as added/removed, not an in-place change.
  assert.equal(detailed.details.find((row) => row.field === 'reviews').added[0].id, 'R2');
  assert.deepEqual(
    detailed.details.find((row) => row.class === 'new-comments'),
    {
      class: 'new-comments',
      field: 'comments',
      from: 1,
      to: 2,
      delta: 1,
      added: [{ id: 'C1', author: 'bot' }],
    },
  );
});

test('--ignore-authors rejects empty members before repository derivation', () => {
  const d = deps([[]]);
  d.resolveRepo = () => {
    throw new Error('must not derive');
  };
  const { code, report } = run(['--ignore-authors', 'bot,', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.match(report.error, /--ignore-authors/);
});

test('--only-classes with no matching delta suppresses attention without changing the snapshot', () => {
  // Removing the only-class branch would incorrectly wake consumers for a
  // ci-changed delta that no requested class admits.
  const before = { ...basePr, checks: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run([...FILTER_ARGS, '--only-classes', 'review-changed'], d);
  assert.equal(code, 0);
  assert.deepEqual(report.deltas, []);
  assert.equal(report.filteredDeltas, 1);
  assert.equal(d.stored.pr['42'].fingerprint.updatedAt, after.updatedAt);
});

test('--only-classes keeps matching deltas and still exits 10', () => {
  // Dropping the positive branch would hide a requested ci transition among
  // unrelated update churn.
  const ciBefore = { ...basePr, checks: [] };
  const ciAfter = {
    ...ciBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const updateBefore = { ...basePr, number: 43, title: 'other PR' };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[ciAfter, updateAfter]], {
    existing: {
      pr: { 42: item(prFingerprint(ciBefore)), 43: item(prFingerprint(updateBefore)) },
      issue: {},
    },
  });
  const { code, report } = run([...FILTER_ARGS, '--only-classes', 'ci-changed'], d);
  assert.equal(code, 10);
  assert.equal(report.deltas.length, 1);
  assert.ok(report.deltas[0].classes.includes('ci-changed'));
  assert.equal(report.filteredDeltas, 1);
});

test('--ignore-classes removes a class but retains a multi-class delta, and drops empty deltas', () => {
  // A filter that deletes the whole multi-class delta loses an actionable head
  // change; one that retains an empty class list emits an invalid delta.
  const headBefore = { ...basePr };
  const headAfter = {
    ...headBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
  };
  const retained = run(
    [...FILTER_ARGS, '--ignore-classes', 'updated'],
    deps([[headAfter]], { existing: { pr: { 42: item(prFingerprint(headBefore)) }, issue: {} } }),
  );
  assert.equal(retained.code, 10);
  assert.deepEqual(retained.report.deltas[0].classes, ['head-changed']);
  assert.equal(retained.report.filteredDeltas, 0);

  const updateBefore = { ...basePr };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const dropped = run(
    [...FILTER_ARGS, '--ignore-classes', 'updated'],
    deps([[updateAfter]], {
      existing: { pr: { 42: item(prFingerprint(updateBefore)) }, issue: {} },
    }),
  );
  assert.equal(dropped.code, 0);
  assert.deepEqual(dropped.report.deltas, []);
  assert.equal(dropped.report.filteredDeltas, 1);
});

test('unknown attention-filter classes are config errors that name the invalid value', () => {
  // Accepting an unknown token silently turns a permanently misconfigured
  // watcher into an apparently healthy no-op.
  for (const flag of ['--only-classes', '--ignore-classes']) {
    const { code, report } = run([...FILTER_ARGS, flag, 'not-a-delta-class'], deps([[]]));
    assert.equal(code, 2);
    assert.equal(report.kind, 'config');
    assert.match(report.error, /not-a-delta-class/);
  }
});

test('--settled drops pending and unknown PRs, keeps ciRollup none, and implies summaries', () => {
  // Treating no CI checks as pending would suppress a settled PR forever; not
  // deriving summaries would let pending/unknown work through unnoticed.
  const pendingBefore = { ...basePr, number: 42, mergeable: 'mergeable' };
  const pendingAfter = {
    ...pendingBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'pending', conclusion: 'pending' }],
  };
  const unknownBefore = { ...basePr, number: 43, mergeable: 'mergeable' };
  const unknownAfter = {
    ...unknownBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    mergeable: 'unknown',
  };
  const noneBefore = { ...basePr, number: 44, mergeable: 'mergeable' };
  const noneAfter = { ...noneBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[pendingAfter, unknownAfter, noneAfter]], {
    existing: {
      pr: {
        42: item(prFingerprint(pendingBefore)),
        43: item(prFingerprint(unknownBefore)),
        44: item(prFingerprint(noneBefore)),
      },
      issue: {},
    },
  });
  const { code, report } = run([...FILTER_ARGS, '--settled'], d);
  assert.equal(code, 10);
  assert.deepEqual(
    report.deltas.map((delta) => delta.number),
    [44],
  );
  assert.equal(report.deltas[0].summary.ciRollup, 'none');
  assert.equal(report.filteredDeltas, 2);
});

test('combined attention filters apply only before ignore, making ignore the final class veto', () => {
  // Reversing the order would drop this delta after ci-changed is vetoed,
  // instead of retaining its independent head/update classes.
  const before = { ...basePr, checks: [] };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    headSha: 'sha2',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const { code, report } = run(
    [...FILTER_ARGS, '--only-classes', 'ci-changed', '--ignore-classes', 'ci-changed'],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['head-changed', 'updated']);
  assert.equal(report.filteredDeltas, 0);
});

test('attention filters leave the persisted snapshot byte-identical and outpost sends survivors only', async () => {
  // Moving filtering before persistence would replay suppressed changes later;
  // sending the unfiltered report would still wake the downstream consumer.
  const ciBefore = { ...basePr, checks: [] };
  const ciAfter = {
    ...ciBefore,
    updatedAt: '2026-07-01T11:00:00Z',
    checks: [{ name: 'ci/test', kind: 'status', status: 'success', conclusion: 'success' }],
  };
  const updateBefore = { ...basePr, number: 43, title: 'other PR' };
  const updateAfter = { ...updateBefore, updatedAt: '2026-07-01T11:00:00Z' };
  const stateDir = mkdtempSync(join(tmpdir(), 'gh-delta-filters-'));
  const unfilteredState = join(stateDir, 'unfiltered.json');
  const filteredState = join(stateDir, 'filtered.json');
  const argsFor = (stateFile) => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    stateFile,
  ];
  const dependencySet = (prs) => ({
    fetchPRs: () => ({ rows: prs, rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    now: () => '2026-07-01T12:00:00Z',
  });
  try {
    for (const stateFile of [unfilteredState, filteredState]) {
      const seeded = run(argsFor(stateFile), dependencySet([ciBefore, updateBefore]));
      assert.equal(seeded.code, 0);
    }
    const unfiltered = run(argsFor(unfilteredState), dependencySet([ciAfter, updateAfter]));
    assert.equal(unfiltered.code, 10);
    const filteredDeps = dependencySet([ciAfter, updateAfter]);
    const posts = [];
    filteredDeps.outpostFetch = async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    };
    const { runWithOutpost } = await import('../lib/cli.mjs');
    const filtered = await runWithOutpost(
      [
        ...argsFor(filteredState),
        '--only-classes',
        'updated',
        '--outpost-url',
        'https://example.com/gh-delta',
      ],
      filteredDeps,
    );
    assert.equal(filtered.code, 10);
    assert.deepEqual(
      filtered.report.deltas.map((delta) => delta.number),
      [43],
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0].number, 43);
    assert.equal(readFileSync(filteredState, 'utf8'), readFileSync(unfilteredState, 'utf8'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--help-json documents the summary schema well enough to build a validator', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help-json'], d);
  assert.equal(code, 0);
  const help = JSON.parse(report);
  assert.ok(help.output.deltaFields.includes('summary'), 'deltaFields advertises summary');
  assert.deepEqual(help.output.deltaSummaryFields, [
    'ciRollup',
    'reviewDecision',
    'mergeable',
    'mergeStateStatus',
    'state',
    'isDraft',
    'unresolvedReviewThreads',
    'headSha',
  ]);
  assert.deepEqual(help.output.deltaSummaryEnums.ciRollup, ['green', 'failed', 'pending', 'none']);
  assert.deepEqual(help.output.deltaSummaryEnums.mergeable, [
    'mergeable',
    'conflicting',
    'unknown',
  ]);
  assert.deepEqual(help.output.deltaSummaryEnums.mergeStateStatus, [
    'behind',
    'blocked',
    'clean',
    'dirty',
    'draft',
    'has_hooks',
    'unstable',
    'unknown',
  ]);
});

test('--help returns usage text without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help'], d);
  assert.equal(code, 0);
  assert.equal(typeof report, 'string');
  assert.ok(report.includes('Usage:'));
});

test('--help-json returns machine-readable help without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help-json'], d);
  assert.equal(code, 0);
  assert.equal(typeof report, 'string');

  const help = JSON.parse(report);
  assert.equal(help.helpSchemaVersion, 1);
  assert.equal(help.command, 'gh-delta');
  assert.match(help.usage, /^gh-delta \[--repo/);
  assert.match(help.usage, /\[--summary-line\]/);
  assert.match(help.usage, /\[--detail\]/);
  assert.ok(help.options.some((option) => option.name === '--monitor-id'));
  assert.ok(help.options.some((option) => option.name === '--state-dir'));
  assert.ok(help.options.some((option) => option.name === '--format'));
  assert.ok(help.options.some((option) => option.name === '--summary-line'));
  assert.ok(help.options.some((option) => option.name === '--rate-limit-floor'));
  assert.match(help.output.description, /resetAt.*rate-limit/i);
  assert.ok(help.options.some((option) => option.name === '--help-json'));
  assert.ok(help.options.some((option) => option.name === '--version'));
  assert.equal(help.version, packageJson.version);
  assert.equal(help.options.find((option) => option.name === '--repo')?.required, false);
  assert.equal(help.options.find((option) => option.name === '--monitor-id')?.required, false);
  assert.match(help.exitCodes.find((entry) => entry.code === 10)?.meaning ?? '', /Deltas found/);
  assert.deepEqual(help.output.formats, ['json', 'text', 'compact', 'ndjson']);
  assert.deepEqual(help.stateConcurrency, {
    sameStateFile: 'locked: one writer at a time, others exit busy (1)',
    overlapRisk:
      'the pre-write fence narrows, but cannot fully close, a lost-update window to a scheduler gap between the fence check and the snapshot rename',
    corruptionRisk: 'atomic writes prevent partial JSON snapshots',
  });
  assert.ok(help.options.some((option) => option.name === '--lock-stale-ms'));
});

test('--version returns package version, npm channel, and release URL without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--version'], d);
  assert.equal(code, 0);
  assert.equal(
    report,
    `gh-delta ${packageJson.version} (npm) https://github.com/diegomarino/gh-delta/releases\n`,
  );
});

test('missing --repo returns code 2 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => ({ status: 'declined' }),
  };
  const { code, report } = run(['--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.match(report.error, /--repo/);
});

test('missing --monitor-id defaults to a stable per-machine host id', () => {
  const d = deps([[]]);
  const { code, report } = run(['--repo', 'o/r'], d);
  assert.equal(code, 0);
  assert.match(report.monitorId, /^host-[0-9a-f]{12}$/);
  assert.ok(d.readPath.includes(`__monitor-${report.monitorId}__`));
  const again = deps([[]]);
  const { report: report2 } = run(['--repo', 'o/r'], again);
  assert.equal(report2.monitorId, report.monitorId); // stable across invocations
});

test('monitor id precedence is flag then environment then the generated default', () => {
  for (const [argv, env, expected] of [
    [['--monitor-id', 'flag'], { GH_DELTA_MONITOR_ID: 'env' }, 'flag'],
    [[], { GH_DELTA_MONITOR_ID: 'env' }, 'env'],
    [[], {}, 'generated'],
  ]) {
    const d = deps([[]]);
    d.env = env;
    d.defaultMonitor = () => 'generated';
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', ...argv], d);
    assert.equal(result.code, 0);
    assert.equal(result.report.monitorId, expected);
  }
  const invalid = deps([[]]);
  invalid.env = { GH_DELTA_MONITOR_ID: '../bad' };
  assert.equal(run(['--repo', 'o/r', '--state-file', '/tmp/x.json'], invalid).code, 2);
});

test('--state-file and --state-dir are mutually exclusive', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--state-dir', '/tmp'],
    d,
  );
  assert.equal(code, 2);
  assert.match(report.error, /mutually exclusive/);
});

test('missing state flags default to a per-user tmpdir-derived snapshot', () => {
  const d = deps([[]]);
  const { code, report } = run(['--repo', 'o/r', '--monitor-id', 'main'], d);
  assert.equal(code, 0);
  assert.ok(d.readPath.startsWith(join(tmpdir(), 'gh-delta-')), d.readPath);
  assert.ok(d.readPath.endsWith(`${'/'}repo-o%2Fr__monitor-main__pr-issue.json`));
  assert.equal(report.stateFile, d.readPath);
  assert.equal(report.baseline, true);
});

test('explicit state flags still resolve verbatim and populate report.stateFile', () => {
  const d = deps([[]]);
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(report.stateFile, '/tmp/x.json');
  const d2 = deps([[]]);
  const { report: report2 } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-dir', '/tmp/state', '--entities', 'pr'],
    d2,
  );
  assert.equal(report2.stateFile, '/tmp/state/repo-o%2Fr__monitor-main__pr.json');
});

test('invalid --entities returns code 2 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--entities',
      'release',
    ],
    d,
  );
  assert.equal(code, 2);
  assert.match(report.error, /--entities/);
});

test('unknown arguments return structured code 2 error', () => {
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--bogus'],
    {
      fetchPRs: () => {
        throw new Error('should not fetch');
      },
      fetchIssues: () => {
        throw new Error('should not fetch');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.match(report.error, /Unknown option|--bogus/);
});

test('--entities pr preserves existing issue snapshot entries', () => {
  const existing = {
    pr: {
      42: item(openFp),
    },
    issue: { 7: { state: 'open', updatedAt: '2026-07-01T10:00:00Z', labels: [], comments: 0 } },
  };
  const d = deps([[basePr]], { existing });
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.ok(d.stored.issue['7']);
});

test('corrupt snapshot read failure returns code 2 and does NOT write', () => {
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => ({ rows: [basePr], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(writes, 0);
  assert.match(report.error, /invalid snapshot JSON/);
});

test('invalid snapshot horizon returns code 2 before fetching', () => {
  let fetched = false;
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetched = true;
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: 'not-a-date' } }),
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'snapshot');
  assert.match(report.error, /invalid snapshot horizon/);
  assert.equal(fetched, false);
  assert.equal(writes, 0);
});

test('invalid repo and monitor id fail before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };

  assert.equal(
    run(['--repo', 'owner/repo/extra', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d)
      .code,
    2,
  );
  assert.equal(
    run(['--repo', 'owner/repo', '--monitor-id', '../bad', '--state-file', '/tmp/x.json'], d).code,
    2,
  );
});

test('existing snapshot is read before GitHub fetches', () => {
  let read = false;
  let fetched = false;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      fetchIssues: () => {
        throw new Error('should not fetch');
      },
      readSnapshot: () => {
        read = true;
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(read, true);
  assert.equal(fetched, false);
  assert.match(report.error, /invalid snapshot/);
});

test('gh-delta sends outpost payloads with monitor id after the snapshot write', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 202 };
  };

  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    d,
  );

  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://example.com/gh-delta');
  assert.equal(posts[0].body.type, 'gh-delta.delta');
  assert.equal(posts[0].body.monitorId, 'main');
  assert.equal(posts[0].body.branch, undefined);
  assert.equal(posts[0].body.eventId, 'gh-delta.delta.v1:o/r:main:pr:42:merged');
  assert.equal(
    posts[0].body.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:merged:2026-07-01T12:00:00Z',
  );
});

test('--format text prints operator output from the main gh-delta binary', async () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });

  const { code, output } = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'text'],
    d,
  );

  assert.equal(code, 10);
  assert.match(output, /2026-07-01T12:00:00Z \| 1 delta\(s\)/);
  assert.match(output, /PR #42 "add widget": merged/);
  assert.match(output, /suggested action: item completed or closed/);
  assert.doesNotMatch(output, /"deltas"/);
});

test('--format json prints the detector report JSON from the main gh-delta binary', async () => {
  const d = deps([[basePr]]);

  const { code, output } = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'json'],
    d,
  );

  assert.equal(code, 0);
  const report = JSON.parse(output);
  assert.equal(report.monitorId, 'main');
  assert.equal(report.baseline, true);
});

test('duplicate --format flags use the same last-value rule for parsing and rendering', async () => {
  const d = deps([[]]);
  const textThenJson = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--format',
      'text',
      '--format',
      'json',
    ],
    d,
  );
  assert.equal(JSON.parse(textThenJson.output).baseline, true);

  const d2 = deps([[]]);
  const jsonThenText = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--format',
      'json',
      '--format',
      'text',
    ],
    d2,
  );
  assert.match(jsonThenText.output, /Baseline seeded/);
});

test('--help-json usage includes detail flags and documents entities grammar', () => {
  const { report } = run(['--help-json'], { now: () => '2026-07-01T12:00:00Z' });
  const help = JSON.parse(report);
  assert.match(help.usage, /\[--summary-line\]/);
  assert.match(help.usage, /\[--detail\]/);
  assert.ok(help.options.some((option) => option.name === '--summary-line'));
  assert.ok(help.output.deltaFields.includes('summaryLine'));
  assert.ok(help.output.deltaFields.includes('line'));
  assert.ok(help.output.deltaFields.includes('details'));
  assert.ok(help.output.deltaDetailFields.includes('opaque'));
  assert.deepEqual(help.output.deltaDetailFieldsByClass['new-comments'], ['comments']);
  assert.deepEqual(help.output.deltaDetailFieldsByClass.relabeled, ['labels']);
  const entities = help.options.find((option) => option.name === '--entities');
  assert.equal(
    entities.grammar,
    'comma-separated unique values from: pr, issue; input order is canonicalized',
  );
});

test('gh-delta rejects invalid --outpost-url before fetching GitHub', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  let fetches = 0;
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'file:///tmp/outpost.json',
    ],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetches++;
        throw new Error('should not fetch');
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => ({ pr: {}, issue: {} }),
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(fetches, 0);
  assert.match(report.error, /--outpost-url must use http: or https:/);
});

test('config validation precedes repo derivation: an invalid --outpost-url short-circuits before resolveRepo runs', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      throw new Error('resolver must not run');
    },
  };
  // --repo is deliberately omitted: resolveRepo would normally run and could
  // shell out to `gh` (network). An invalid --outpost-url is a deterministic,
  // repo-independent config error and must be reported before any GitHub
  // access is attempted.
  const { code, report } = run(
    ['--state-file', '/tmp/x.json', '--outpost-url', 'file:///tmp/outpost.json'],
    d,
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-url must use http: or https:/);
});

test('outpost eventId is order-independent across class permutations', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const report = { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' };
  const a = buildOutpostPayload({
    report,
    delta: { entity: 'pr', number: 42, title: 'x', classes: ['review-changed', 'ci-changed'] },
  });
  const b = buildOutpostPayload({
    report,
    delta: { entity: 'pr', number: 42, title: 'x', classes: ['ci-changed', 'review-changed'] },
  });
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.deliveryId, b.deliveryId);
  assert.equal(a.eventId, 'gh-delta.delta.v1:o/r:main:pr:42:ci-changed+review-changed');
  assert.equal(
    a.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:ci-changed+review-changed:2026-07-01T12:00:00Z',
  );
});

test('outpost eventId is stable across detector timestamps while deliveryId changes', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = { entity: 'pr', number: 42, title: 'x', classes: ['merged'] };
  const first = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  const second = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:01Z' },
    delta,
  });

  assert.equal(first.eventId, second.eventId);
  assert.notEqual(first.deliveryId, second.deliveryId);
});

test('outpost eventId repeats across different observed states while id does not (regression: id is the dedupe key, not eventId)', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const report = { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' };
  // Same PR, same class set (ci-changed), two successive observed states —
  // e.g. CI went red, then green. A receiver that dedupes by eventId would
  // silently drop the second one; this is exactly the bug being fixed.
  const first = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      title: 'x',
      classes: ['ci-changed'],
      to: item({ state: 'open', ciRollup: 'red' }),
    },
  });
  const second = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      title: 'x',
      classes: ['ci-changed'],
      to: item({ state: 'open', ciRollup: 'green' }),
    },
  });
  assert.equal(first.eventId, second.eventId);
  assert.notEqual(first.id, second.id);
});

test('outpost id is stable across runs and across monitorId values for the same observed change', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = {
    entity: 'pr',
    number: 42,
    title: 'x',
    classes: ['merged'],
    to: item({ state: 'merged' }),
  };
  const a = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  const b = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-08-01T00:00:00Z' },
    delta,
  });
  const c = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'other-monitor', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  // eventId and deliveryId both include monitorId, so they diverge where id doesn't.
  assert.notEqual(a.eventId, c.eventId);
});

test('outpost payload has exactly the documented key set (shape/byte-stability guard)', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' },
    delta: {
      entity: 'pr',
      number: 42,
      title: 'x',
      classes: ['merged'],
      headRefName: 'feature',
      to: item({ state: 'merged', labels: [] }),
    },
  });
  assert.deepEqual(
    Object.keys(payload).sort(),
    [
      'classes',
      'delta',
      'deliveryId',
      'detectedAt',
      'entity',
      'eventId',
      'headRefName',
      'id',
      'labels',
      'line',
      'links',
      'monitorId',
      'number',
      'repo',
      'schemaVersion',
      'state',
      'title',
      'type',
    ].sort(),
  );
});

test('outpost mirrors optional transient enrichment without adding it to legacy payloads', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const base = {
    report: { repo: 'o/r', monitorId: 'main', at: 'now' },
    delta: { entity: 'issue', number: 1, title: 'x', classes: ['new-comments'] },
  };
  assert.equal(Object.hasOwn(buildOutpostPayload(base), 'enrichment'), false);
  const enrichment = {
    comments: [{ id: 'C1', author: 'a', createdAt: 'now', body: 'hi', mentions: [] }],
  };
  assert.deepEqual(
    buildOutpostPayload({ ...base, delta: { ...base.delta, enrichment } }).enrichment,
    enrichment,
  );
});

test('--enrich decorates surviving deltas only after snapshot publication and leaves the durable log canonical', () => {
  const before = {
    ...basePr,
    reviews: [],
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C1', author: 'old' }],
    threads: [{ id: 'T1', resolved: true }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewDecision: 'changes_requested',
    reviews: [
      {
        id: 'R1',
        state: 'changes_requested',
        submittedAt: 'now',
        author: 'a',
        commit: 'b',
      },
    ],
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C1', author: 'old' },
      { id: 'C2', author: 'new' },
    ],
    threads: [{ id: 'T1', resolved: false }],
  };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const order = [];
  d.writeSnapshotAtomic = (_path, value) => {
    order.push('snapshot');
    d.snapshotBytes = JSON.stringify(value);
  };
  d.appendDeltaLog = (_path, value) => {
    order.push('log');
    d.logged = value;
  };
  d.fetchEnrichment = (kind, ids) => {
    order.push(kind);
    assert.equal(order[0], 'log');
    assert.equal(order[1], 'snapshot');
    if (kind === 'review')
      return {
        rows: [
          {
            id: ids[0],
            author: 'a',
            state: 'changes_requested',
            submittedAt: 'now',
            commit: 'b',
            body: 'fix',
          },
        ],
        rateLimit: RATE_LIMIT,
      };
    if (kind === 'comments')
      return {
        rows: [{ id: ids[0], author: 'b', createdAt: 'now', body: '@alice' }],
        rateLimit: RATE_LIMIT,
      };
    return {
      rows: [
        {
          id: ids[0],
          firstComment: {
            id: 'TC',
            author: 'c',
            createdAt: 'now',
            path: 'x',
            line: 2,
            originalLine: 1,
            body: 'body',
          },
        },
      ],
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--log',
      '--enrich',
      'review,comments,threads',
    ],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(order, ['log', 'snapshot', 'review', 'comments', 'threads']);
  assert.deepEqual(Object.keys(result.report.deltas[0].enrichment).sort(), [
    'comments',
    'review',
    'threads',
  ]);
  assert.equal(JSON.stringify(d.logged).includes('enrichment'), false);
  assert.equal(d.snapshotBytes.includes('enrichment'), false);
  assert.match(result.report.deltas[0].enrichment.comments[0].mentions[0], /alice/);
});

test('--enrich invalid selection is rejected before repository derivation', () => {
  let derived = false;
  const result = run(['--enrich', 'review,', '--state-file', '/tmp/x.json'], {
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      derived = true;
      throw new Error('must not derive');
    },
  });
  assert.equal(result.code, 2);
  assert.equal(derived, false);
  assert.match(result.report.error, /--enrich/);
});

test('--help wins over unknown flags and invalid outpost URLs', () => {
  const d = { now: () => '2026-07-01T12:00:00Z' };
  const helpWithBogus = run(['--help', '--bogus'], d);
  assert.equal(helpWithBogus.code, 0);
  assert.ok(helpWithBogus.report.includes('Usage:'));
  const helpWithBadOutpost = run(['--help', '--outpost-url', 'not-a-url'], d);
  assert.equal(helpWithBadOutpost.code, 0);
  const helpJsonWins = run(['--help-json', '--repo'], d);
  assert.equal(helpJsonWins.code, 0);
  assert.equal(JSON.parse(helpJsonWins.report).helpSchemaVersion, 1);
});

test('duplicate --outpost-url uses last-wins like every other flag', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const existing = {
    pr: {
      42: item(openFp),
    },
    issue: {},
  };
  const d = deps([[{ ...basePr, comments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing,
  });
  const posts = [];
  d.outpostFetch = async (url) => {
    posts.push(url);
    return { ok: true, status: 202 };
  };
  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://first.example',
      '--outpost-url',
      'https://second.example',
    ],
    d,
  );
  assert.equal(code, 10); // a real delta fired, and it was delivered
  assert.ok(posts.length > 0);
  // validateOutpostUrl normalizes via `new URL(...).href`, which appends a
  // trailing slash to a bare-origin URL; match on origin to stay robust to that.
  assert.ok(posts.every((url) => new URL(url).origin === 'https://second.example'));
});

test('error kinds map to exit codes: config/snapshot=2, github/io/busy=1', () => {
  const base = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];
  const noFetch = { ...NOOP_LOCK_DEPS, now: () => '2026-07-01T12:00:00Z' };
  const config = run(
    ['--repo', 'o/r', '--monitor-id', '../bad', '--state-file', '/tmp/x.json'],
    noFetch,
  );
  assert.equal(config.code, 2);
  assert.equal(config.report.kind, 'config');
  const snapshot = run(base, {
    ...noFetch,
    readSnapshot: () => {
      throw new Error('invalid snapshot JSON at /tmp/x.json');
    },
  });
  assert.equal(snapshot.code, 2);
  assert.equal(snapshot.report.kind, 'snapshot');
  const github = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  });
  assert.equal(github.code, 1);
  assert.equal(github.report.kind, 'github');
  const io = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    writeSnapshotAtomic: () => {
      throw new Error('ENOSPC');
    },
  });
  assert.equal(io.code, 1);
  assert.equal(io.report.kind, 'io');
  let fetched = false;
  const busy = run(base, {
    ...noFetch,
    acquireLock: () => ({ ok: false, reason: 'held' }),
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  });
  assert.equal(busy.code, 1);
  assert.equal(busy.report.kind, 'busy');
  assert.equal(fetched, false); // busy is raised before any GitHub call
});

test('sendOutposts stops after the configured max payload count', async () => {
  const { sendOutposts } = await import('../lib/outpost.mjs');
  const report = {
    repo: 'o/r',
    monitorId: 'main',
    at: '2026-07-01T12:00:00Z',
    deltas: [
      { entity: 'pr', number: 1, title: 'one', classes: ['new'] },
      { entity: 'pr', number: 2, title: 'two', classes: ['new'] },
    ],
  };
  const posts = [];
  const { warnings } = await sendOutposts({
    outpostUrl: 'https://example.com',
    report,
    maxPosts: 1,
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    },
  });

  assert.equal(posts.length, 1);
  assert.deepEqual(warnings, [
    { label: 'outpost', reason: 'skipped 1 delta(s) after max outpost post count 1' },
  ]);
});

test('outpost warnings land inside the JSON report, not on stderr', async () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  d.outpostFetch = async () => ({ ok: false, status: 500 });
  const { code, output, stderr } = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(stderr, '');
  const report = JSON.parse(output);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0].reason, /HTTP 500/);
});

test('--outpost-max-posts caps delivery from the CLI', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const existing = { pr: {}, issue: {} };
  const d = deps([[basePr, { ...basePr, number: 43, title: 'second' }]], { existing });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, warnings } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
      '--outpost-max-posts',
      '1',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(posts.length, 1);
  assert.match(warnings[0].reason, /skipped 1 delta/);
});

test('--gh-timeout-ms abc is a config error (exit 2, kind config)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      'abc',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--gh-timeout-ms/);
});

test('--rate-limit-floor validates before repository derivation or state access', () => {
  for (const floor of ['-1', '1.5', 'nope', '', String(Number.MAX_SAFE_INTEGER + 1)]) {
    let derived = false;
    let read = false;
    const result = run(['--rate-limit-floor', floor], {
      now: () => '2026-07-01T12:00:00Z',
      resolveRepo: () => {
        derived = true;
        return { repo: 'o/r', source: 'gh' };
      },
      readSnapshot: () => {
        read = true;
        return null;
      },
    });
    assert.equal(result.code, 2, floor);
    assert.equal(result.report.kind, 'config', floor);
    assert.match(result.report.error, /--rate-limit-floor/, floor);
    assert.equal(derived, false, floor);
    assert.equal(read, false, floor);
  }
});

test('--rate-limit-floor gates fetch after snapshot read and reports a low quota without writes', () => {
  const order = [];
  let writes = 0;
  let registered;
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--rate-limit-floor',
      '4',
    ],
    {
      ...NOOP_LOCK_DEPS,
      readSnapshot: () => {
        order.push('read');
        return null;
      },
      fetchRateLimit: (_options) => {
        order.push('rate');
        return { remaining: 3, resetAt: '2026-07-01T13:00:00.000Z' };
      },
      fetchPRs: () => {
        order.push('fetch');
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => {
        order.push('fetch');
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      writeSnapshotAtomic: () => {
        writes++;
      },
      registerMonitor: (entry) => {
        registered = entry;
      },
      now: () => '2026-07-01T12:00:00Z',
      env: {},
    },
  );
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'rate-limit');
  assert.equal(result.report.resetAt, '2026-07-01T13:00:00.000Z');
  // The pre-fetch REST check shares {cost, remaining, resetAt} with the
  // post-fetch GraphQL rateLimit; cost is null since a REST quota read has
  // no per-query cost of its own.
  assert.equal(result.report.remaining, 3);
  assert.equal(result.report.cost, null);
  assert.match(result.report.error, /remaining 3.*floor 4/);
  assert.deepEqual(order, ['read', 'rate']);
  assert.equal(writes, 0);
  assert.equal(registered.status, 'failure');
  assert.equal(registered.error.kind, 'rate-limit');
});

test('--rate-limit-floor allows equality and forwards timeout before the observation fetch', () => {
  const order = [];
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--rate-limit-floor',
      '4',
      '--gh-timeout-ms',
      '321',
    ],
    {
      ...NOOP_LOCK_DEPS,
      readSnapshot: () => null,
      fetchRateLimit: (options) => {
        order.push(['rate', options.timeoutMs]);
        return { remaining: 4, resetAt: '2026-07-01T13:00:00.000Z' };
      },
      fetchPRs: () => {
        order.push(['fetch']);
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      writeSnapshotAtomic: () => {},
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(order, [['rate', 321], ['fetch']]);
});

test('a tick spanning two entity families accumulates cost and keeps the last remaining/resetAt', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({
      rows: [],
      rateLimit: { cost: 4, remaining: 100, resetAt: '2026-07-01T13:00:00.000Z' },
    }),
    fetchIssues: () => ({
      rows: [],
      rateLimit: { cost: 2, remaining: 98, resetAt: '2026-07-01T13:00:01.000Z' },
    }),
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    now: () => '2026-07-01T12:00:00Z',
  };
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 0);
  // TODO(R3): this is the same accumulator the eventual results[].rateLimit
  // report field will surface; see the TODO comment at its definition site
  // in lib/cli.mjs's runSingle.
  assert.deepEqual(result.rateLimit, {
    cost: 6,
    remaining: 98,
    resetAt: '2026-07-01T13:00:01.000Z',
  });
});

test('enrichment cost accumulates into the same tick-level rateLimit as the observation fetches', () => {
  const before = {
    ...basePr,
    comments: 1,
    conversationComments: 1,
    recentComments: [{ id: 'C1', author: 'old' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    comments: 2,
    conversationComments: 2,
    recentComments: [
      { id: 'C1', author: 'old' },
      { id: 'C2', author: 'new' },
    ],
  };
  const d = deps([[after]], {
    existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} },
  });
  d.fetchPRs = () => ({
    rows: [after],
    rateLimit: { cost: 4, remaining: 100, resetAt: '2026-07-01T13:00:00.000Z' },
  });
  d.fetchEnrichment = () => ({
    rows: [{ id: 'C2', author: 'a', createdAt: 'now', body: 'hi' }],
    rateLimit: { cost: 1, remaining: 99, resetAt: '2026-07-01T13:00:01.000Z' },
  });
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--enrich',
      'comments',
    ],
    d,
  );
  assert.equal(result.code, 10);
  // 4 (PR fetch) + 1 (default issue fetch from deps()) + 1 (enrichment).
  assert.deepEqual(result.rateLimit, {
    cost: 6,
    remaining: 99,
    resetAt: '2026-07-01T13:00:01.000Z',
  });
});

test('omitting --rate-limit-floor makes no rate-limit call', () => {
  let calls = 0;
  const d = deps([[]]);
  d.fetchRateLimit = () => {
    calls++;
    return { remaining: 0, resetAt: '2026-07-01T13:00:00.000Z' };
  };
  run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(calls, 0);
});

test('--gh-timeout-ms threads into fetchers and defaults to 60000', () => {
  let receivedTimeoutMs;
  const makeDeps = () => ({
    ...NOOP_LOCK_DEPS,
    fetchPRs: (_repo, opts) => {
      receivedTimeoutMs = opts.timeoutMs;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    now: () => '2026-07-01T12:00:00Z',
  });

  run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], makeDeps());
  assert.equal(receivedTimeoutMs, 60000);

  run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      '5000',
    ],
    makeDeps(),
  );
  assert.equal(receivedTimeoutMs, 5000);
});

test('non-numeric outpost flags are config errors (exit 2)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-timeout-ms',
      'soon',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-timeout-ms/);
});

test('the CLI threads the snapshot horizon into fetchers and stamps a new one', () => {
  let receivedCutoff = 'unset';
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: (_repo, opts) => {
      receivedCutoff = opts.horizonCutoff;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: '2026-07-01T11:00:00.000Z' } }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
  assert.equal(receivedCutoff, '2026-07-01T10:55:00.000Z');
  assert.equal(d.written.meta.horizon, '2026-07-01T12:00:00.000Z');
});

test('--detail reports the current missing tick for still-missing', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({
      pr: {
        42: item(openFp, { missingTicks: 1 }),
      },
      issue: {},
      meta: DEFAULT_OLD_META,
    }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--entities',
      'pr',
      '--detail',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['still-missing']);
  assert.equal(report.deltas[0].missingTicks, 2);
  assert.equal(report.deltas[0].details[0].missingTicks, 2);
});

test('mixed-case --repo shares one snapshot and one eventId space', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'O/R',
      '--monitor-id',
      'main',
      '--state-dir',
      '/tmp/state',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(report.repo, 'o/r');
  assert.equal(d.readPath, '/tmp/state/repo-o%2Fr__monitor-main__pr-issue.json');
  assert.equal(posts[0].eventId, 'gh-delta.delta.v1:o/r:main:pr:42:merged');
  assert.match(posts[0].links.html, /^https:\/\/github\.com\/o\/r\/pull\/42$/);
});

test('list subcommand returns a read-only inventory report with code 0', () => {
  const calls = [];
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: (stateDir, options) => {
      calls.push([stateDir, options.sinceMs]);
      return {
        monitors: [
          {
            repo: 'o/r',
            monitorId: 'prs-5m',
            entities: ['pr'],
            stateFile: '/state/repo-o%2Fr__monitor-prs-5m__pr.json',
            lastRun: '2026-07-08T11:00:00.000Z',
            prCount: 2,
            issueCount: 0,
          },
        ],
        skippedFiles: 1,
      };
    },
  };
  const { code, report } = run(['list', '--state-dir', '/state', '--since', '24h'], d);
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, 'list');
  assert.equal(report.stateDir, '/state');
  assert.equal(report.since, '24h');
  assert.equal(report.at, '2026-07-08T12:00:00.000Z');
  assert.equal(report.monitors.length, 1);
  assert.equal(report.skippedFiles, 1);
  assert.equal(report.summary, '1 monitor(s)');
  assert.deepEqual(calls, [['/state', 86_400_000]]);
});

test('list rejects an invalid --since as a permanent config error', () => {
  const { code, report } = run(['list', '--since', 'yesterday'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--since/);
});

test('list maps an unreadable state directory to a transient io error', () => {
  const { code, report } = run(['list', '--state-dir', '/state'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(code, 1);
  assert.equal(report.kind, 'io');
  assert.match(report.error, /EACCES/);
});

test('list --help and --help-json describe the subcommand without touching disk', () => {
  const d = {
    listMonitors: () => {
      throw new Error('must not be called');
    },
  };
  const helpText = run(['list', '--help'], d);
  assert.equal(helpText.code, 0);
  assert.match(helpText.report, /gh-delta list \[--state-dir <dir>\]/);
  const helpJson = run(['list', '--help-json'], d);
  assert.equal(helpJson.code, 0);
  const help = JSON.parse(helpJson.report);
  assert.equal(help.command, 'gh-delta list');
  assert.ok(help.options.some((option) => option.name === '--since'));
  assert.equal(
    help.exitCodes.find((entry) => entry.code === 0)?.meaning.includes('Inventory'),
    true,
  );
});

test('main --help advertises the list subcommand', () => {
  const { report } = run(['--help'], {});
  assert.match(report, /Subcommands:/);
  assert.match(report, /\n {2}list\s+Read-only inventory/);
});

test('list --format text renders one line per monitor plus skipped files', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({
      monitors: [
        {
          repo: 'o/r',
          monitorId: 'prs-5m',
          entities: ['pr', 'issue'],
          stateFile: '/state/x.json',
          lastRun: '2026-07-08T11:00:00.000Z',
          prCount: 2,
          issueCount: 3,
        },
        {
          repo: 'o/r',
          monitorId: 'broken',
          entities: ['pr'],
          stateFile: '/state/y.json',
          lastRun: '2026-07-08T10:00:00.000Z',
          prCount: null,
          issueCount: null,
          error: 'invalid snapshot JSON at /state/y.json',
        },
      ],
      skippedFiles: 2,
    }),
  };
  const { code, output } = await runCommand(
    ['list', '--state-dir', '/state', '--format', 'text'],
    d,
  );
  assert.equal(code, 0);
  assert.match(output, /^2026-07-08T12:00:00\.000Z \| 2 monitor\(s\) \| \/state\n/);
  assert.match(
    output,
    /o\/r \| monitor: prs-5m \| entities: pr,issue \| schema: .* \| last run: 2026-07-08T11:00:00\.000Z \| 2 PR\(s\), 3 issue\(s\)/,
  );
  assert.match(output, /o\/r \| monitor: broken \| .* \| snapshot error: invalid snapshot JSON/);
  assert.match(output, /2 unrecognized file\(s\) skipped\./);
});

test('list --format text reports an empty inventory and echoes the window', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({ monitors: [], skippedFiles: 0 }),
  };
  const windowed = await runCommand(
    ['list', '--state-dir', '/state', '--since', '1h', '--format', 'text'],
    d,
  );
  assert.match(windowed.output, /No monitor snapshots ran in the last 1h\./);
  const bare = await runCommand(['list', '--state-dir', '/state', '--format', 'text'], d);
  assert.match(bare.output, /No monitor snapshots found\./);
});

test('list errors in text mode do not borrow snapshot/delta vocabulary', async () => {
  const d = deps([[basePr]]);
  const { output, code } = await runCommand(
    ['list', '--state-dir', '/state', '--since', 'yesterday', '--format', 'text'],
    d,
  );
  assert.equal(code, 2);
  assert.match(output, /gh-delta list error: --since must be/);
  assert.doesNotMatch(output, /delta\(s\)/);
  assert.doesNotMatch(output, /[Ss]napshot was not updated/);
});

test('a successful run leaves an idempotent registry breadcrumb', () => {
  const d = deps([[basePr]]);
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  d.env = {};
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].repo, 'o/r');
  assert.equal(registered[0].monitorId, 'main');
  assert.deepEqual(registered[0].entities, ['pr']);
  assert.equal(registered[0].stateFile, '/tmp/x.json');
  assert.equal(registered[0].lastRun, '2026-07-01T12:00:00Z');
});

test('--no-registry and GH_DELTA_NO_REGISTRY both skip the breadcrumb', () => {
  for (const args of [
    { argv: ['--no-registry'], env: {} },
    { argv: [], env: { GH_DELTA_NO_REGISTRY: '1' } },
  ]) {
    const d = deps([[basePr]]);
    d.registerMonitor = () => {
      throw new Error('must not be called');
    };
    d.env = args.env;
    const { code } = run(
      ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', ...args.argv],
      d,
    );
    assert.equal(code, 0);
  }
});

test('GH_DELTA_NO_REGISTRY only disables the breadcrumb for values that mean "on"', () => {
  // Regression: a plain truthiness test made GH_DELTA_NO_REGISTRY=0 (meaning
  // "registry ON" to a wrapper author) silently skip registration. `0`, `false`,
  // and empty are now treated as unset so the breadcrumb is still written.
  for (const value of ['0', 'false', 'FALSE', '', '  ']) {
    const d = deps([[basePr]]);
    const registered = [];
    d.registerMonitor = (entry) => registered.push(entry);
    d.env = { GH_DELTA_NO_REGISTRY: value };
    const { code } = run(
      ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
      d,
    );
    assert.equal(code, 0);
    assert.equal(
      registered.length,
      1,
      `GH_DELTA_NO_REGISTRY=${JSON.stringify(value)} must still register`,
    );
  }
});

test('a registry write failure never changes the run result', () => {
  const d = deps([[basePr]]);
  d.registerMonitor = () => {
    throw new Error('EACCES: registry dir unwritable');
  };
  d.env = {};
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.baseline, true);
  assert.equal(d.writes, 1);
});

test('a failed detector attempt updates the registry without changing its result', () => {
  const d = deps([[]]);
  d.env = {};
  d.fetchPRs = () => {
    throw new Error('offline');
  };
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'github');
  assert.deepEqual(
    registered.map(({ status, error }) => [status, error?.kind]),
    [['failure', 'github']],
  );
});

test('a busy detector attempt is recorded as a registry failure', () => {
  const d = deps([[]]);
  d.env = {};
  d.acquireLock = () => ({ ok: false, reason: 'held' });
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'busy');
  assert.deepEqual(
    registered.map(({ status, error }) => [status, error?.kind]),
    [['failure', 'busy']],
  );
});

test('generated monitor identity collision warning is included on success and failure', () => {
  for (const fail of [false, true]) {
    const d = deps([[]]);
    d.env = {};
    d.defaultMonitor = () => 'host-current';
    d.machineId = 'machine-a';
    d.readRegistry = () => ({
      entries: [{ repo: 'o/r', machineId: 'machine-a', monitorId: 'host-other' }],
      skippedFiles: 0,
    });
    if (fail)
      d.fetchPRs = () => {
        throw new Error('offline');
      };
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', '--format', 'text'], d);
    assert.equal(result.code, fail ? 1 : 0);
    assert.ok(result.warnings.some((warning) => warning.label === 'monitor-id'));
  }
});

test('monitor identity collision warning excludes inapplicable and unavailable registry cases', () => {
  const cases = [
    { argv: ['--format', 'json'], env: {} },
    { argv: ['--format', 'text', '--monitor-id', 'host-current'], env: {} },
    { argv: ['--format', 'text'], env: { GH_DELTA_MONITOR_ID: 'host-current' } },
    {
      argv: ['--format', 'text'],
      env: {},
      entry: { repo: 'o/r', machineId: 'machine-a', monitorId: 'host-current' },
    },
    {
      argv: ['--format', 'text'],
      env: {},
      entry: { repo: 'x/y', machineId: 'machine-a', monitorId: 'host-other' },
    },
    {
      argv: ['--format', 'text'],
      env: {},
      entry: { repo: 'o/r', machineId: 'machine-b', monitorId: 'host-other' },
    },
    { argv: ['--format', 'text'], env: {}, registryError: true },
  ];
  for (const { argv, env, entry, registryError } of cases) {
    const d = deps([[]]);
    d.env = env;
    d.defaultMonitor = () => 'host-current';
    d.machineId = 'machine-a';
    d.readRegistry = () => {
      if (registryError) throw new Error('unreadable registry');
      return {
        entries: [entry ?? { repo: 'o/r', machineId: 'machine-a', monitorId: 'host-other' }],
      };
    };
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', ...argv], d);
    assert.equal(
      result.warnings.some((warning) => warning.label === 'monitor-id'),
      false,
    );
  }
});

test('snapshots are self-describing: meta carries identity next to horizon', () => {
  const d = deps([[basePr]]);
  run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.deepEqual(d.stored.meta, {
    schemaVersion: 2,
    ghDeltaVersion: d.stored.meta.ghDeltaVersion,
    repo: 'o/r',
    monitorId: 'main',
    entities: ['pr'],
    scope: 'poll',
    horizon: '2026-07-01T12:00:00Z',
    createdAt: '2026-07-01T12:00:00Z',
    updatedAt: '2026-07-01T12:00:00Z',
  });
  assert.match(d.stored.meta.ghDeltaVersion, /^\d+\.\d+\.\d+/);
});

test('list without --state-dir consults the run registry; --state-dir narrows to a scan', () => {
  const captured = [];
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    env: { GH_DELTA_REGISTRY_DIR: '/reg' },
    listMonitors: (stateDir, options) => {
      captured.push([stateDir, options.registryDir]);
      return { monitors: [], skippedFiles: 0 };
    },
  };
  const global = run(['list'], d);
  assert.equal(global.report.registryDir, '/reg');
  assert.equal(captured[0][1], '/reg');
  const narrowed = run(['list', '--state-dir', '/state'], d);
  assert.equal(narrowed.report.registryDir, null);
  assert.deepEqual(captured[1], ['/state', null]);
});

// Minimal deps that let run() reach the report without touching disk/network.
const baseDeps = (over = {}) => ({
  ...NOOP_LOCK_DEPS,
  fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  readSnapshot: () => null,
  writeSnapshotAtomic: () => {},
  registerMonitor: () => {},
  now: () => '2026-07-28T00:00:00.000Z',
  env: { GH_DELTA_NO_REGISTRY: '1' },
  ...over,
});

test('explicit --repo never calls resolveRepo and reports repoSource:flag', () => {
  let called = false;
  const res = run(
    ['--repo', 'owner/repo', '--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => {
        called = true;
        return { status: 'declined' };
      },
    }),
  );
  assert.equal(called, false);
  assert.equal(res.report.repoSource, 'flag');
  assert.equal(res.report.repo, 'owner/repo');
});

test('absent --repo uses the derived repo and its source', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'Acme/Proj',
        source: 'git-remote',
        warnings: [],
      }),
    }),
  );
  assert.equal(res.report.repo, 'acme/proj'); // validateRepo lowercased it
  assert.equal(res.report.repoSource, 'git-remote');
});

test('derivation declined -> config error, exit 2', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({ resolveRepo: () => ({ status: 'declined' }) }),
  );
  assert.equal(res.code, 2);
  assert.equal(res.report.kind, 'config');
  assert.match(res.report.error, /could not derive/);
});

test('derivation failed transiently -> github error, exit 1', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({ resolveRepo: () => ({ status: 'failed', reason: 'timed out after 60000ms' }) }),
  );
  assert.equal(res.code, 1);
  assert.equal(res.report.kind, 'github');
});

test('divergence warning from derivation rides on the run result', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0].reason, /acme\/proj/);
});

test('derivation divergence warning appears in JSON report.warnings', async () => {
  const out = await runCommand(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  const report = JSON.parse(out.output);
  assert.ok(report.warnings?.some((w) => /acme\/proj/.test(w.reason)));
});

test('derivation divergence warning appears in text output', async () => {
  const out = await runCommand(
    ['--state-file', '/tmp/x.json', '--no-registry', '--format', 'text'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  assert.match(out.output, /acme\/proj/);
});

test('schema subcommand is local-only and emits a newline-terminated schema', async () => {
  let touched = false;
  const result = await runCommand(['schema', '--format', 'compact'], {
    now: () => '2026-09-20T00:00:00Z',
    fetchPRs: () => {
      touched = true;
      return [];
    },
    readSnapshot: () => {
      touched = true;
      return null;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(touched, false);
  assert.equal(JSON.parse(result.output).title, 'compact report');
  assert.ok(result.output.endsWith('\n'));
});

test('schema rejects an unknown format as configuration error', () => {
  const result = run(['schema', '--format', 'text'], { now: () => '2026-09-20T00:00:00Z' });
  assert.equal(result.code, 2);
  assert.match(result.report.error, /json, compact, or ndjson/);
});

test('single-repo compact output derives per-delta repo and URL from the report', async () => {
  const before = { ...basePr, updatedAt: '2026-07-01T10:00:00Z' };
  const after = { ...basePr, updatedAt: '2026-07-01T11:00:00Z', state: 'closed' };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const result = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'compact'],
    d,
  );
  const report = JSON.parse(result.output);
  assert.equal(report.deltas[0].repo, 'o/r');
  assert.equal(report.deltas[0].url, 'https://github.com/o/r/pull/42');
});
