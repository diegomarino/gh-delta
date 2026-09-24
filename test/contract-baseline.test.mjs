// ============================================================================
// CONTRACT: the zero-new-flags CLI path must stay byte-for-byte identical to
// released v0.7.0 (schema v2), forever. Every future PR is additive; any
// drift here on a no-flags invocation is a BREAKING CONTRACT CHANGE, not a
// fixture bug.
//
// These golden fixtures were regenerated exactly once, by hand-reviewed
// design, as the schema-v2 epic's single deliberate act (E0): schema v1's
// fixtures were retired along with REPORT_SCHEMA_VERSION 1. Do not regenerate
// again outside of an equally deliberate, human-reviewed schemaVersion bump.
//
// This test compares REAL SERIALIZED BYTES on both sides, not parsed objects:
//   - Report: the `output` string returned by `runCommand()` (the exact
//     stdout bytes a caller would see) is compared with `assert.equal`
//     against the fixture's raw text, read with no JSON.parse.
//   - Snapshot: the run writes through the real `writeSnapshotAtomic()` to a
//     real file in a fresh temp directory (via `--state-file`); the file's
//     raw bytes are compared with `assert.equal` against the fixture's raw
//     text, again with no JSON.parse. This matters because JSON.parse +
//     deepEqual would ignore property order, and `lib/cli.mjs` deliberately
//     rebuilds each delta as `{ id: ..., ...d }` so the dedupe key leads the
//     serialized object -- a reordering regression only shows up in bytes.
//
// If this test fails after a change you made:
//   - Do NOT "fix" it by regenerating the golden files to match new output.
//   - The failure means the report or snapshot bytes changed for callers who
//     pass no new flags. That requires an explicit schemaVersion decision
//     (see lib/contract.mjs, REPORT_SCHEMA_VERSION) made deliberately by a
//     human, not silently absorbed by updating a fixture.
//   - If the change really is intentional and versioned correctly, regenerate
//     with GH_DELTA_UPDATE_BASELINE=1 (see below) and review the diff by hand
//     before committing it.
//
// Golden fixtures live in test/fixtures/baseline/. Each of the three
// invocations (run1: baseline seed, run2: tick with deltas, run3: no-change
// tick) has an `*-observation.json` (the shape fetchPRs/fetchIssues return)
// and expected `*-expected-report.json` / `*-expected-snapshot.json` files
// holding the exact bytes `lib/cli.mjs` `runCommand()` and
// `lib/snapshot.mjs` `writeSnapshotAtomic()` produced for that tick,
// hand-inspected before being committed.
//
// To regenerate (only when a change is a deliberate, reviewed contract
// change): run this file with GH_DELTA_UPDATE_BASELINE=1 set, e.g.
//   GH_DELTA_UPDATE_BASELINE=1 node --test test/contract-baseline.test.mjs
// This rewrites the golden files verbatim from the current code's actual
// output bytes instead of asserting against them. Review the diff before
// committing.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GH_DELTA_NO_REGISTRY = '1';

import { runCommand } from '../lib/cli.mjs';
import { REPORT_FIELDS } from '../lib/contract.mjs';

const UPDATE = process.env.GH_DELTA_UPDATE_BASELINE === '1';

const FIX_DIR = new URL('./fixtures/baseline/', import.meta.url);
const REPO = 'acme/widgets';
const MONITOR_ID = 'contract-baseline';

function fixtureUrl(name) {
  return new URL(name, FIX_DIR);
}

// Raw fixture text -- no JSON.parse. Byte comparison must see exactly what
// is on disk, including (the absence of) a trailing newline.
function readFixtureText(name) {
  return readFileSync(fixtureUrl(name), 'utf8');
}

function readFixtureJson(name) {
  return JSON.parse(readFixtureText(name));
}

function writeFixtureText(name, text) {
  writeFileSync(fixtureUrl(name), text);
}

function makeTmpStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-baseline-'));
  return { dir, stateFile: join(dir, 'state.json') };
}

function argv(stateFile) {
  return ['--repo', REPO, '--monitor-id', MONITOR_ID, '--state-file', stateFile];
}

// The report echoes back the --state-file path it was given. That path lives
// in a fresh mkdtemp'd directory (a different, unpredictable name every run,
// by design of mkdtemp) so the snapshot write exercises the real filesystem.
// Swap the actual path for a stable placeholder before comparing/recording
// report bytes, so the fixture stays deterministic without faking anything
// about the serialized JSON itself.
const STATE_FILE_PLACEHOLDER = '<STATE_FILE>';
function normalizeStateFile(text, stateFile) {
  return text.split(stateFile).join(STATE_FILE_PLACEHOLDER);
}

function assertBytesEqualOrUpdate(actualText, expectedFixtureName, message) {
  if (UPDATE) {
    writeFixtureText(expectedFixtureName, actualText);
    return;
  }
  const expectedText = readFixtureText(expectedFixtureName);
  assert.equal(actualText, expectedText, message);
}

function contractBreakMessage(what) {
  return (
    `${what} for the zero-new-flags path no longer matches the committed golden ` +
    `fixture bytes. This means the no-flags CLI output changed shape, content, or ` +
    `property order -- a BREAKING CONTRACT CHANGE that requires an explicit ` +
    `schemaVersion decision, not a fixture regeneration. See the comment at the ` +
    `top of this file.`
  );
}

test('contract-baseline: run1 seeds a baseline with no deltas', async () => {
  const observation = readFixtureJson('run1-observation.json');
  const { dir, stateFile } = makeTmpStateDir();
  try {
    const result = await runCommand(argv(stateFile), {
      fetchPRs: () => ({ rows: observation.pr, rateLimit: null }),
      fetchIssues: () => ({ rows: observation.issue, rateLimit: null }),
      now: () => '2026-01-01T00:00:00Z',
      env: {},
    });
    assert.equal(result.code, 0);
    assert.equal(result.report.results[0].baseline, true);
    assert.deepEqual(result.report.deltas, []);
    // Sanity: report only carries fields from the frozen contract list.
    for (const key of Object.keys(result.report)) {
      assert.ok(
        REPORT_FIELDS.includes(key),
        `unexpected report field "${key}" not in REPORT_FIELDS`,
      );
    }
    assertBytesEqualOrUpdate(
      normalizeStateFile(result.output, stateFile),
      'run1-expected-report.json',
      contractBreakMessage('run1 report'),
    );
    const snapshotBytes = readFileSync(stateFile, 'utf8');
    assertBytesEqualOrUpdate(
      snapshotBytes,
      'run1-expected-snapshot.json',
      contractBreakMessage('run1 snapshot'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contract-baseline: run2 reports real deltas against the prior snapshot', async () => {
  const observation = readFixtureJson('run2-observation.json');
  const { dir, stateFile } = makeTmpStateDir();
  try {
    // Seed the prior tick's state by writing the previous run's fixture
    // bytes straight into the state file, exercising the real read path.
    writeFileSync(stateFile, readFixtureText('run1-expected-snapshot.json'));
    const result = await runCommand(argv(stateFile), {
      fetchPRs: () => ({ rows: observation.pr, rateLimit: null }),
      fetchIssues: () => ({ rows: observation.issue, rateLimit: null }),
      now: () => '2026-01-01T01:00:00Z',
      env: {},
    });
    assert.equal(result.code, 10);
    assert.equal(result.report.deltas.length, 2);
    for (const delta of result.report.deltas) {
      assert.match(delta.id, /^[0-9a-f]{64}$/, `delta id "${delta.id}" must be 64-char sha256 hex`);
    }
    assertBytesEqualOrUpdate(
      normalizeStateFile(result.output, stateFile),
      'run2-expected-report.json',
      contractBreakMessage('run2 report'),
    );
    const snapshotBytes = readFileSync(stateFile, 'utf8');
    assertBytesEqualOrUpdate(
      snapshotBytes,
      'run2-expected-snapshot.json',
      contractBreakMessage('run2 snapshot'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contract-baseline: run3 is a no-change tick with zero deltas', async () => {
  const observation = readFixtureJson('run3-observation.json');
  const { dir, stateFile } = makeTmpStateDir();
  try {
    writeFileSync(stateFile, readFixtureText('run2-expected-snapshot.json'));
    const result = await runCommand(argv(stateFile), {
      fetchPRs: () => ({ rows: observation.pr, rateLimit: null }),
      fetchIssues: () => ({ rows: observation.issue, rateLimit: null }),
      now: () => '2026-01-01T02:00:00Z',
      env: {},
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.report.deltas, []);
    assertBytesEqualOrUpdate(
      normalizeStateFile(result.output, stateFile),
      'run3-expected-report.json',
      contractBreakMessage('run3 report'),
    );
    const snapshotBytes = readFileSync(stateFile, 'utf8');
    assertBytesEqualOrUpdate(
      snapshotBytes,
      'run3-expected-snapshot.json',
      contractBreakMessage('run3 snapshot'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guard: the v1 compat surface the schema-v2 epic retired must not creep
// back into live code. `lib/fingerprint.mjs` is allowed one historical
// mention of `comparableFingerprint` explaining what v1 used to do (marked
// as history, no parens -- never called); a real reintroduction would call
// it as a function. Docs and test comments that narrate the removal by name
// are out of scope here (see docs/contract.md and test suites); this guard
// only walks the shipped code surfaces named in the schema-v2 epic plan.
test('schema-v2 leftover sweep: retired v1 identifiers do not reappear in shipped code', () => {
  const roots = ['lib', 'examples', 'tools/examples'].map(
    (dir) => new URL(`../${dir}/`, import.meta.url),
  );
  const files = [];
  const walk = (dirUrl) => {
    for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
      if (entry.isDirectory()) walk(entryUrl);
      else if (/\.(mjs|js|json|md)$/.test(entry.name)) files.push(entryUrl);
    }
  };
  for (const root of roots) walk(root);

  const forbidden = [
    { name: 'hideInternalDetails', pattern: /hideInternalDetails/ },
    { name: 'stripMissingBookkeeping', pattern: /stripMissingBookkeeping/ },
    { name: 'commentsOverflow', pattern: /commentsOverflow/ },
    // The retired `delta.line` alias and its `legacyLine` gate (see R3).
    { name: 'delta.line alias', pattern: /\bdelta\.line\b|\blegacyLine\b/ },
    // A live `comparableFingerprint` call/definition, not the historical
    // prose mention in lib/fingerprint.mjs (which never appends `(`).
    { name: 'comparableFingerprint call/definition', pattern: /comparableFingerprint\s*\(/ },
    // v1's upgrade-compat guards for snapshots predating a given field.
    {
      name: 'oldFp compat guard',
      pattern: /typeof oldFp\.\w+\s*===\s*['"]string['"]|Array\.isArray\(oldFp\./,
    },
  ];

  for (const fileUrl of files) {
    const text = readFileSync(fileUrl, 'utf8');
    for (const { name, pattern } of forbidden) {
      assert.equal(
        pattern.test(text),
        false,
        `${fileUrl.pathname} still references retired identifier/pattern "${name}"`,
      );
    }
  }
});
