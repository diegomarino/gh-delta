// Guard: R3 moved `stateFile`/`logFile`/`baseline`/`errors` from the
// detector report's top level into `results[]`. FIVE of the six schema-v2
// audit P1s were callers still reading the old top-level path -- every one
// failed SILENTLY, because `undefined` disappears on JSON serialization and
// `results[0]` still looked error-free (see lib/dx.mjs's initializeMonitor,
// fixed alongside this guard: it read `baseline.report?.stateFile` and
// `baseline.report?.baseline`, both always-undefined off a real v2 report).
//
// Three layers, each catching a different half of the failure:
//   (1) a static source sweep for the exact shape of every fixed instance --
//       a `<something>report` reference (a literal `.report` property, or an
//       identifier ending in `Report`) immediately dereferencing one of the
//       four retired fields. This catches CONSUMERS, but is brittle against
//       aliasing: `const r = x.report; r.stateFile` slips through unnoticed,
//       by design (see the task's own caveat) -- it only catches the literal
//       spelling every real instance of this bug used. See SWEEP_ROOTS below
//       for exactly what this covers and what it deliberately does not.
//   (2) a runtime shape assertion that a real, enveloped v2 report (one that
//       carries `results[]`, i.e. not the pre-flight bareError shape) never
//       carries these fields at its own top level. This catches PRODUCERS --
//       something that starts writing a stale top-level field again -- but
//       NOT consumers who misread an already-correct report, which is
//       exactly what lib/dx.mjs's bug was; (2) alone would have stayed green
//       through it.
//   (3) an integration assertion that the real, public single- and
//       multi-repo report surface exposes these fields ONLY under
//       `results[]`, with the values matching what a live tick actually
//       produced -- not just their absence at the top.
// (1)+(3) between them cover the consumer gap (2) cannot; none of the three
// catches a consumer that copies a result row's field to a differently named
// local variable before misusing it three lines later -- no static or
// black-box check can, short of full dataflow analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../lib/cli.mjs';

const STALE_FIELDS = ['stateFile', 'logFile', 'baseline', 'errors'];
// Matches `<identifier ending in Report>.<field>` or `.report.<field>` (with
// an optional `?.`) -- the literal shape every fixed instance used
// (`tickReport.stateFile`, `baseline.report?.stateFile`, ...). Deliberately
// does not match the bare identifier `report` itself: every subcommand other
// than the detector (`status`, `reset`, `log compact`, ...) legitimately
// names its OWN top-level report object `report` and legitimately carries
// some of these same field names at its own top level (see lib/contract.mjs's
// RESET_REPORT_FIELDS/COMPACT_REPORT_FIELDS) -- only a *nested* `.report` (a
// detector tick's report reached through another object) or a `*Report`-named
// alias is a v1-shape suspect.
const STALE_PATH_PATTERN = new RegExp(
  `(?:\\.report|\\b\\w*Report)\\??\\.(${STALE_FIELDS.join('|')})\\b`,
);

// Directories walked for `.mjs`/`.js`/`.md` files, plus a short list of
// individual root-level files. This is a JS-property-access regex, so it
// only ever catches JS source and Markdown code fences/prose written in that
// style -- see the exclusions below for what that leaves out.
//
// Covered, and why each belongs:
//   - lib/            production code -- the primary target.
//   - examples/        shipped integration snippets users copy verbatim.
//   - tools/            build/doc-generation scripts (schema, skill docs,
//                       the README example-artifact renderer) that consume
//                       real report shapes to build committed output.
//   - docs/             prose that names real report field paths.
//   - skills/           the packaged `gh-delta` skill's reference docs,
//                       shipped alongside the package.
//   - test/e2e/         the ONE test/ subtree included: these scripts spawn
//                       the real `gh-delta` binary as a subprocess and parse
//                       its genuine stdout JSON (see
//                       test/e2e/playground-e2e-helpers.mjs's
//                       detectorResultFromProcess) -- a real consumer, not a
//                       mock. This is exactly the gap that let
//                       test/e2e/playground-e2e.mjs:257 read the retired
//                       `report.baseline` for an entire round undetected:
//                       `npm run check` never runs it (it needs live GitHub
//                       credentials), so nothing but this sweep could have
//                       caught it, and the sweep didn't look there.
//   - gh-delta.mjs      the published bin entrypoint (root-level, scanned
//                       individually, not as a directory).
//
// Deliberately excluded:
//   - the rest of test/ (unit/integration tests). These intentionally
//     construct old-shape literals for mocks and regression fixtures (e.g.
//     a `deps()` fake, or a fixture proving code correctly REJECTS a v1
//     shape) -- scanning them would flag deliberate historical shapes as
//     false positives. Unlike test/e2e/, they never call the real CLI as a
//     subprocess and parse its genuine output.
//   - `.github/workflows/*.yml` and other YAML/jq consumers (e.g.
//     examples/github-actions-slack-digest/gh-delta-watch.yml, which reads
//     `jq -r '.results[0].baseline // false'`). This regex is JS-syntax
//     specific and cannot match jq's `.baseline`/`.results[0].baseline`
//     shape at all -- adding `.yml` to the extension filter would add no
//     real coverage here, only false confidence. Spot-checked by hand and
//     currently clean; a jq-aware stale-path detector would need to be a
//     separate tool, not an extension added to this one.
const SWEEP_ROOTS = ['lib', 'examples', 'tools', 'docs', 'skills', 'test/e2e'];
const SWEEP_ROOT_FILES = ['gh-delta.mjs'];

test('no shipped code dereferences the retired v1 top-level report paths', () => {
  const files = SWEEP_ROOT_FILES.map((name) => new URL(`../${name}`, import.meta.url));
  const walk = (dirUrl) => {
    for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
      if (entry.isDirectory()) walk(entryUrl);
      else if (/\.(mjs|js|md)$/.test(entry.name)) files.push(entryUrl);
    }
  };
  for (const root of SWEEP_ROOTS) walk(new URL(`../${root}/`, import.meta.url));

  for (const fileUrl of files) {
    const text = readFileSync(fileUrl, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      assert.equal(
        STALE_PATH_PATTERN.test(line),
        false,
        `${fileUrl.pathname}:${i + 1} dereferences a retired v1 top-level report path: ${line.trim()}`,
      );
    });
  }
});

const locks = {
  acquireLock: () => ({ ok: true, token: 'test-lock' }),
  releaseLock: () => ({ ok: true }),
  assertLockOwned: () => true,
};
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00.000Z' };

function assertNoStaleTopLevelFields(report, context) {
  for (const field of STALE_FIELDS) {
    assert.equal(
      Object.hasOwn(report, field),
      false,
      `${context}: report must not carry a top-level "${field}" (moved to results[] by R3)`,
    );
  }
}

test('a real single-repo report exposes stateFile/baseline only under results[]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-no-stale-single-'));
  try {
    const result = run(['--repo', 'o/r', '--monitor-id', 'm', '--state-dir', dir, '--log'], {
      ...locks,
      now: () => '2026-01-01T00:00:00.000Z',
      fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    });
    assert.equal(result.code, 0);
    assertNoStaleTopLevelFields(result.report, 'single-repo baseline');
    assert.equal(typeof result.report.results[0].stateFile, 'string');
    assert.equal(result.report.results[0].baseline, true);
    assert.equal(typeof result.report.results[0].logFile, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real multi-repo report exposes stateFile/baseline/logFile only under results[]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-no-stale-multi-'));
  try {
    const result = run(
      ['--repo', 'o/one,o/two', '--monitor-id', 'm', '--state-dir', dir, '--log'],
      {
        ...locks,
        now: () => '2026-01-01T00:00:00.000Z',
        fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
        fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
        env: { GH_DELTA_NO_REGISTRY: '1' },
      },
    );
    assert.equal(result.code, 0);
    assertNoStaleTopLevelFields(result.report, 'multi-repo baseline');
    assert.equal(result.report.results.length, 2);
    for (const row of result.report.results) {
      assert.equal(typeof row.stateFile, 'string');
      assert.equal(row.baseline, true);
      assert.equal(typeof row.logFile, 'string');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real post-resolution failure exposes its error only under results[], never top-level errors', () => {
  const result = run(['--repo', 'o/r', '--monitor-id', 'm', '--state-file', '/tmp/x.json'], {
    ...locks,
    now: () => '2026-01-01T00:00:00.000Z',
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => {
      throw new Error('invalid snapshot JSON');
    },
    writeSnapshotAtomic: () => {},
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(result.code, 2);
  assertNoStaleTopLevelFields(result.report, 'post-resolution failure');
  assert.ok(result.report.results[0].error);
});

test('the bare pre-flight error shape legitimately has no results[] and no stale top-level fields either', () => {
  // No repo is ever resolved here (a bad flag), so this is the OTHER
  // documented shape (lib/schema.mjs's bareError): no `results`, kept
  // deliberately un-enveloped. The stale-field guard above still applies --
  // this shape never had stateFile/logFile/baseline/errors even pre-R3.
  const result = run(['--unknown'], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(Object.hasOwn(result.report, 'results'), false);
  assertNoStaleTopLevelFields(result.report, 'bare pre-flight error');
});
