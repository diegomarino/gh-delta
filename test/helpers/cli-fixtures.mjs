// Shared fixtures for public CLI contract tests (`run` / `runCommand`).
// Tests must never leave breadcrumbs in the developer's real run registry.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prFingerprint } from '../../lib/fingerprint.mjs';

export const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const basePr = {
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

// Schema v2 snapshot item shape: `{ fingerprint, context, meta }` (see
// lib/snapshot.mjs). Wraps a bare fingerprint fragment (often built by
// prFingerprint) into the shape a persisted snapshot map now stores.
export const item = (fingerprint, meta = {}) => ({
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

// The prior-tick fingerprint most `existing` snapshot fixtures start from:
// PR 42 at rest, matching a fresh fetch of `basePr`.
export const openFp = prFingerprint(basePr);

// This suite is about detector behavior, not lock behavior (see
// test/lock.test.mjs and test/cli-lock.test.mjs for that) -- and many tests
// intentionally share literal state-file paths (e.g. /tmp/x.json)
// across independent runs. A real fs-backed lock at that shared path would
// make cross-file test parallelism racy. Every deps() object here stubs the
// lock as an always-uncontended no-op so run() exercises the full lock
// call sequence (acquire -> fence -> release) without ever touching disk.
export const NOOP_LOCK_DEPS = {
  acquireLock: () => ({ ok: true, token: 'test-lock-token' }),
  releaseLock: () => ({ ok: true, released: true }),
  assertLockOwned: () => true,
};

// Every fetcher's real (lib/gh.mjs) return shape is `{ rows, rateLimit }`.
// Most tests here don't care about the quota number, so this is the shared
// default a mocked fetch gets unless a test overrides `fetchRateLimit`/the
// fetcher itself to assert on it (see the accumulation tests near
// --rate-limit-floor).
export const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-07-01T13:00:00.000Z' };

// Schema v2 snapshot-wide meta is mandatory (lib/snapshot.mjs). Most
// `existing` fixtures only care about pr/issue contents, so `deps()`
// stamps a valid default meta onto any `existing` snapshot that doesn't
// already carry one.
export const DEFAULT_OLD_META = {
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

export function deps(prSeq, { existing = null } = {}) {
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

export function strictPrDir(prefix, count) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (let number = 1; number <= count; number++) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  return dir;
}

// A prior tick's fingerprint that predates the `checks[]` field entirely (a
// legacy snapshot written before schema v2's row-level check tracking).
export function opaqueCiFixture() {
  const fp = prFingerprint({ ...basePr, updatedAt: '2026-07-01T10:00:00Z' });
  delete fp.checks;
  return fp;
}

export const SUMMARIES_ARGS = [
  '--repo',
  'o/r',
  '--monitor-id',
  'main',
  '--state-file',
  '/tmp/x.json',
  '--summaries',
];

export const BASELINE_EMIT_ARGS = [
  '--repo',
  'o/r',
  '--monitor-id',
  'main',
  '--state-file',
  '/tmp/x.json',
  '--baseline-emit-state',
];

export const FILTER_ARGS = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];

export function threadReplyFixture(threadCommentsBefore, threadCommentsAfter) {
  const before = {
    ...basePr,
    reviewComments: threadCommentsBefore,
    threads: [{ id: 'T1', resolved: false, comments: threadCommentsBefore }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    reviewComments: threadCommentsAfter,
    threads: [{ id: 'T1', resolved: false, comments: threadCommentsAfter }],
  };
  return { before, after };
}

// Minimal deps that let run() reach the report without touching disk/network.
export const baseDeps = (over = {}) => ({
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

export function depsForSecondTick() {
  return deps([[basePr], [{ ...basePr, updatedAt: '2026-07-01T13:00:00Z', headSha: 'sha2' }]]);
}
