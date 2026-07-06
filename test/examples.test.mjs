// Contract guardrail for the README example fixtures.
//
// The static/animated example artifacts are rendered from tools/examples/
// fixtures. If the report shape in lib/contract.mjs changes, these assertions
// fail so the fixtures (and therefore the committed SVGs) get regenerated
// instead of silently drifting — closing the gap the 2026-07-05 docs audit
// flagged (recommendation 6.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_FIELDS,
  DELTA_FIELDS,
  DELTA_DETAIL_FIELDS,
  DELTA_DETAIL_FIELDS_BY_CLASS,
} from '../lib/contract.mjs';
import { enrichDelta } from '../lib/cli.mjs';
import { baselineReport, deltaReport, detailReport } from '../tools/examples/fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const keySet = (obj) => new Set(Object.keys(obj));

test('every example report covers exactly the frozen REPORT_FIELDS', () => {
  for (const [name, report] of Object.entries({ baselineReport, deltaReport, detailReport })) {
    assert.deepEqual(
      [...keySet(report)].sort(),
      [...REPORT_FIELDS].sort(),
      `${name} must exercise exactly the contract report fields`,
    );
  }
});

test('a fully enriched delta covers exactly the frozen DELTA_FIELDS', () => {
  // --detail is the richest mode: it attaches summaryLine, line, and details.
  const delta = clone(detailReport.deltas[0]);
  enrichDelta(delta, { summaryLine: true, legacyLine: true, details: true });
  assert.deepEqual(
    [...keySet(delta)].sort(),
    [...DELTA_FIELDS].sort(),
    'the detail fixture delta must exercise every contract delta field',
  );
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
