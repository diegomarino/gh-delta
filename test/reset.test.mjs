// `gh-delta reset` tests: closes the historical TODO(v0.2) doctor/reset gap.
// Deletes a monitor's snapshot, log manifest, and log data file under the
// monitor lock, releasing the lock last so a concurrent tick can never
// observe a half-deleted monitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../lib/cli.mjs';
import { RESET_REPORT_FIELDS } from '../lib/contract.mjs';
import { writeSnapshotAtomic } from '../lib/snapshot.mjs';
import { appendDeltaLog } from '../lib/deltalog.mjs';

const REPO = 'o/r';
const MONITOR = 'm';

// Schema v2 item/meta shapes -- see lib/snapshot.mjs.
const item = (fingerprint = { state: 'OPEN' }) => ({
  fingerprint,
  context: {},
  meta: {
    seenAt: null,
    changedAt: null,
    ticksSinceChange: 0,
    missingTicks: 0,
    staleEmittedFor: null,
  },
});
const META = (overrides = {}) => ({
  schemaVersion: 2,
  ghDeltaVersion: '0.0.0-test',
  repo: REPO,
  monitorId: MONITOR,
  entities: ['pr'],
  scope: 'poll',
  horizon: '2026-09-20T11:00:00.000Z',
  createdAt: '2026-09-20T11:00:00.000Z',
  updatedAt: '2026-09-20T11:00:00.000Z',
  ...overrides,
});

const pr = {
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-09-20T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'sha1',
};

function seedMonitor(stateFile) {
  writeSnapshotAtomic(stateFile, { pr: { 42: item() }, issue: {}, meta: META() });
  const logFile = `${stateFile}.deltalog.ndjson`;
  appendDeltaLog(logFile, {
    detectedAt: '2026-09-20T11:00:00.000Z',
    deltas: [{ id: 'a'.repeat(64), entity: 'pr', number: 42, title: 'x', classes: ['new'] }],
    repo: REPO,
    monitorId: MONITOR,
  });
  return logFile;
}

test('reset without --yes fails as a config error before acquiring any lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reset-'));
  const stateFile = join(dir, 'state.json');
  seedMonitor(stateFile);
  const result = run(
    ['reset', '--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile],
    {
      acquireLock: () => assert.fail('reset without --yes must not acquire the lock'),
      now: () => '2026-09-20T12:00:00.000Z',
    },
  );
  assert.equal(result.code, 2);
  assert.equal(result.report.kind, 'config');
  assert.match(result.report.error, /--yes/);
  // Nothing was touched.
  assert.ok(existsSync(stateFile));
});

test('reset --yes deletes the snapshot, the log manifest, and the log data file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reset-'));
  const stateFile = join(dir, 'state.json');
  const logFile = seedMonitor(stateFile);
  const manifestFile = `${logFile}.published.json`;
  assert.ok(existsSync(stateFile));
  assert.ok(existsSync(logFile));
  assert.ok(existsSync(manifestFile));

  const result = run(
    ['reset', '--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--yes'],
    { now: () => '2026-09-20T12:00:00.000Z' },
  );
  assert.equal(result.code, 0);
  assert.equal(existsSync(stateFile), false);
  assert.equal(existsSync(logFile), false);
  assert.equal(existsSync(manifestFile), false);
});

test('reset --yes on a clean/never-run monitor is a no-op that still exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reset-'));
  const stateFile = join(dir, 'never-existed.json');
  const result = run(
    ['reset', '--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--yes'],
    { now: () => '2026-09-20T12:00:00.000Z' },
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.command, 'reset');
});

test('reset report covers exactly RESET_REPORT_FIELDS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reset-'));
  const stateFile = join(dir, 'state.json');
  seedMonitor(stateFile);
  const result = run(
    ['reset', '--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--yes'],
    { now: () => '2026-09-20T12:00:00.000Z' },
  );
  assert.deepEqual(Object.keys(result.report).sort(), [...RESET_REPORT_FIELDS].sort());
  assert.equal(result.report.stateFile, stateFile);
  assert.match(result.report.logFile, /\.deltalog\.ndjson$/);
});

test('a tick contending for the lock during reset gets busy; once reset completes a later tick starts against clean state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-reset-lock-'));
  const stateFile = join(dir, 'state.json');
  seedMonitor(stateFile);

  let nested;
  const resetResult = run(
    ['reset', '--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--yes'],
    {
      now: () => '2026-09-20T12:00:00.000Z',
      // Fires a real nested tick while reset still holds the monitor lock and
      // is mid-deletion, then performs the real (ENOENT-tolerant) deletion --
      // exercising the actual lock-contention path, not a mock of it.
      deleteSnapshot(path) {
        nested = run(
          ['--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--entities', 'pr'],
          {
            fetchPRs: () => [pr],
            fetchIssues: () => [],
            now: () => '2026-09-20T12:00:01.000Z',
          },
        );
        try {
          unlinkSync(path);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      },
    },
  );

  assert.equal(resetResult.code, 0);
  assert.ok(nested, 'the nested tick must have run while reset held the lock');
  assert.equal(nested.code, 1);
  assert.equal(nested.report.kind, 'busy');

  // Lock released; a later tick against the same --state-file now sees fully
  // clean state (no leftover snapshot or log), not a half-deleted monitor.
  const after = run(
    ['--repo', REPO, '--monitor-id', MONITOR, '--state-file', stateFile, '--entities', 'pr'],
    {
      fetchPRs: () => [pr],
      fetchIssues: () => [],
      now: () => '2026-09-20T12:00:02.000Z',
    },
  );
  assert.equal(after.code, 0);
  assert.equal(after.report.baseline, true);
});
