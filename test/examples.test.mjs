// Contract guardrail for the README example fixtures.
//
// The static/animated example artifacts are rendered from tools/examples/
// fixtures. If the report shape in lib/contract.mjs changes, these assertions
// fail so the fixtures (and therefore the committed SVGs) get regenerated
// instead of silently drifting — closing the gap the 2026-07-05 docs audit
// flagged (recommendation 6.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPORT_FIELDS,
  DELTA_FIELDS,
  DELTA_DETAIL_FIELDS,
  DELTA_DETAIL_FIELDS_BY_CLASS,
} from '../lib/contract.mjs';
import { enrichDelta } from '../lib/cli.mjs';
import { deltaId, deltaIdentity } from '../lib/fingerprint.mjs';
import { baselineReport, deltaReport, detailReport } from '../tools/examples/fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const keySet = (obj) => new Set(Object.keys(obj));

test('every example report covers exactly the frozen REPORT_FIELDS, minus the omit-when-empty ones', () => {
  // lib/cli.mjs's run() never puts `warnings` on the base report object; it is
  // only spliced in by runCommand() when outpost delivery returned at least
  // one warning (see the `!result.warnings?.length` guard there). A live run
  // on the common path these fixtures depict therefore omits `warnings`
  // entirely, so the frozen field list minus that key is what a real report
  // covers here — asserting the raw REPORT_FIELDS set would require a key no
  // live run actually emits (audit finding F10.1).
  const OMIT_WHEN_EMPTY = new Set(['warnings']);
  const expected = [...REPORT_FIELDS].filter((field) => !OMIT_WHEN_EMPTY.has(field));
  for (const [name, report] of Object.entries({ baselineReport, deltaReport, detailReport })) {
    assert.deepEqual(
      [...keySet(report)].sort(),
      [...expected].sort(),
      `${name} must exercise exactly the contract report fields a live run would populate`,
    );
    for (const field of OMIT_WHEN_EMPTY) {
      assert.equal(
        field in report,
        false,
        `${name} must omit "${field}" the way a live run does when it is empty`,
      );
    }
  }
});

test('fully enriched deltas jointly cover exactly the frozen DELTA_FIELDS', () => {
  // No single delta carries every field: `missingTicks` is missing-lifecycle
  // only (to === null, no current object), while `headRefName` is PR-only and
  // only present when a current object exists (to !== null). They are mutually
  // exclusive, so coverage is asserted over the union of a missing delta and a
  // PR change delta. --detail is the richest mode (summaryLine, line, details).
  const missing = {
    entity: 'pr',
    number: 42,
    title: '(missing from current fetch)',
    classes: ['still-missing'],
    missingTicks: 2,
    from: { state: 'OPEN', missing: true, missingTicks: 1 },
    to: null,
  };
  const change = {
    entity: 'pr',
    number: 7,
    title: 'Add widget',
    headRefName: 'feature/widget',
    classes: ['new-comments'],
    from: { state: 'OPEN', comments: 1 },
    to: { state: 'OPEN', comments: 3 },
  };
  // `id` is attached at report assembly (with repo in scope), not by enrichDelta;
  // attach it to both representative deltas so the union also covers `id`.
  missing.id = deltaId(deltaIdentity('owner/repo', missing));
  change.id = deltaId(deltaIdentity('owner/repo', change));
  // `summaries: true` on the PR change delta (which has a to-state) adds `summary`;
  // the missing delta (to === null) correctly gets none, so the union covers it.
  enrichDelta(missing, { summaryLine: true, legacyLine: true, details: true, summaries: true });
  enrichDelta(change, { summaryLine: true, legacyLine: true, details: true, summaries: true });
  const union = new Set([...keySet(missing), ...keySet(change)]);
  assert.deepEqual(
    [...union].sort(),
    [...DELTA_FIELDS].sort(),
    'the detail fixture deltas must jointly exercise every contract delta field',
  );
});

test('every example delta carries the canonical content-addressed id', () => {
  // Guards the actual fixture objects fed to the cast/SVG renderers (not just a
  // synthetic delta), so a new mandatory delta field cannot silently drift the
  // shipped README artifacts.
  for (const [name, report] of Object.entries({ deltaReport, detailReport })) {
    for (const delta of report.deltas) {
      assert.match(delta.id, /^[0-9a-f]{64}$/, `${name} #${delta.number} must carry a hex id`);
      assert.equal(
        delta.id,
        deltaId(deltaIdentity(report.repo, delta)),
        `${name} #${delta.number} id must be the canonical hash of its identity`,
      );
    }
  }
});

test('PR example deltas carry headRefName; issue example deltas do not', () => {
  // Guards the real fixtures fed to the cast/SVG renderers, so the shipped
  // README artifacts cannot silently drift from the PR-only headRefName contract.
  for (const [name, report] of Object.entries({ deltaReport, detailReport })) {
    for (const delta of report.deltas) {
      if (delta.entity === 'pr') {
        assert.equal(
          'headRefName' in delta,
          true,
          `${name} PR #${delta.number} must carry headRefName`,
        );
        assert.ok(
          typeof delta.headRefName === 'string' || delta.headRefName === null,
          `${name} PR #${delta.number} headRefName must be a string or null`,
        );
      } else {
        assert.equal(
          'headRefName' in delta,
          false,
          `${name} issue #${delta.number} must not carry headRefName`,
        );
      }
    }
  }
});

test('every emitted detail row stays within the frozen detail contract', () => {
  const allowedFields = new Set(DELTA_DETAIL_FIELDS);
  for (const report of [deltaReport, detailReport]) {
    for (const raw of report.deltas) {
      const delta = clone(raw);
      enrichDelta(delta, { details: true });
      for (const row of delta.details) {
        for (const key of Object.keys(row)) {
          assert.ok(allowedFields.has(key), `detail key "${key}" is not in DELTA_DETAIL_FIELDS`);
        }
        const byClass = DELTA_DETAIL_FIELDS_BY_CLASS[row.class];
        assert.ok(byClass, `no field map for delta class "${row.class}"`);
        // `presence`/`unknown` are synthetic markers, not fingerprint fields.
        if (!['presence', 'unknown'].includes(row.field)) {
          assert.ok(
            byClass.includes(row.field),
            `field "${row.field}" not declared for class "${row.class}"`,
          );
        }
      }
    }
  }
});

test('the detail report is internally consistent: flag-free command, entities, and stateFile agree', () => {
  // The `--format json --detail` cast in tools/examples/generate-cast.mjs
  // renders `detailReport` behind the literal command below, which carries no
  // `--entities` flag. A flag-free command defaults to monitoring both
  // entities, so the echoed `entities` must be `["pr", "issue"]` — matching
  // both the command and the `__pr-issue` segment of the state file name —
  // rather than the narrower `["pr"]` a `--entities pr` run would echo
  // (fixes audit finding F10.2, the "impossible --entities echo").
  const command = 'gh-delta --repo owner/repo --format json --detail';
  assert.equal(command.includes('--entities'), false, 'the rendered command must stay flag-free');
  assert.deepEqual(
    detailReport.entities,
    ['pr', 'issue'],
    'a flag-free command must echo both entities, matching the __pr-issue state file',
  );
  assert.match(
    detailReport.stateFile,
    /__pr-issue\.json$/,
    'stateFile must carry the __pr-issue segment that matches entities: ["pr", "issue"]',
  );
});

test('the GitHub Actions Slack example does not save corrupt snapshot state', () => {
  const workflow = readFileSync(
    new URL('../examples/github-actions-slack-digest/gh-delta-watch.yml', import.meta.url),
    'utf8',
  );

  assert.match(
    workflow,
    /name: Save snapshot state[\s\S]*if: \$\{\{ always\(\) && steps\.tick\.outputs\.code != '2' \}\}/,
  );
});
