// Contract guardrail for the README example fixtures.
//
// The static/animated example artifacts are rendered from tools/examples/
// fixtures. If the report shape in lib/contract.mjs changes, these assertions
// fail so the fixtures (and therefore the committed SVGs) get regenerated
// instead of silently drifting — closing the gap the 2026-07-05 docs audit
// flagged (recommendation 6.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // one warning (see the `!result.warnings?.length` guard there).
  // `filteredDeltas` is similarly absent without an attention-filter flag.
  // A live run on the common no-warning/no-filter path these fixtures depict
  // `logFile` is likewise absent unless the opt-in --log flag is supplied.
  // A live run on the common no-warning/no-filter/no-log/non-economical path these
  // fixtures depict therefore omits those keys (including scope, emitted only by
  // economical watch reports), so the frozen field list minus those keys is
  // what a real report covers here — asserting the raw REPORT_FIELDS set would
  // require a key no live run actually emits (audit finding F10.1).
  const OMIT_WHEN_EMPTY = new Set([
    'warnings',
    'filteredDeltas',
    'logFile',
    'scope',
    'repos',
    'errors',
  ]);
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
  // Schema v2: `from`/`to` are snapshot items (`{ fingerprint, context, meta }`).
  const item = (fingerprint, meta = {}) => ({ fingerprint, context: {}, meta });
  const missing = {
    entity: 'pr',
    number: 42,
    title: '(missing from current fetch)',
    classes: ['still-missing'],
    missingTicks: 2,
    from: item({ state: 'OPEN' }, { missingTicks: 1 }),
    to: null,
  };
  const change = {
    repo: 'owner/repo',
    entity: 'pr',
    number: 7,
    title: 'Add widget',
    headRefName: 'feature/widget',
    author: 'octocat',
    url: 'https://github.com/owner/repo/pull/7',
    classes: ['new-comments'],
    from: item({ state: 'OPEN', comments: 1 }),
    to: item({ state: 'OPEN', comments: 3 }),
    enrichment: {
      comments: [
        {
          id: 'C_1',
          author: 'octo',
          createdAt: '2026-07-01T12:00:00Z',
          body: 'Please check @owner/team',
          mentions: ['owner/team'],
        },
      ],
    },
  };
  // `id` is attached at report assembly (with repo in scope), not by enrichDelta;
  // attach it to both representative deltas so the union also covers `id`.
  missing.id = deltaId(deltaIdentity('owner/repo', missing));
  change.id = deltaId(deltaIdentity('owner/repo', change));
  // `summaries: true` on the PR change delta (which has a to-state) adds `summary`;
  // the missing delta (to === null) correctly gets none, so the union covers it.
  enrichDelta(missing, { summaryLine: true, legacyLine: true, details: true, summaries: true });
  enrichDelta(change, { summaryLine: true, legacyLine: true, details: true, summaries: true });
  // The public detail fixture contributes a representative stale delta, whose
  // UTC period is a public field rather than fingerprint state.
  const union = new Set([
    ...keySet(missing),
    ...keySet(change),
    ...detailReport.deltas.flatMap((delta) => Object.keys(delta)),
  ]);
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

test('the detail report is internally consistent: command, entities, and stateFile agree', () => {
  // The `--format json --detail --stale-after 24h` cast in tools/examples/generate-cast.mjs
  // renders `detailReport` behind the literal command below, which carries no
  // `--entities` flag. A flag-free command defaults to monitoring both
  // entities, so the echoed `entities` must be `["pr", "issue"]` — matching
  // both the command and the `__pr-issue` segment of the state file name —
  // rather than the narrower `["pr"]` a `--entities pr` run would echo
  // (fixes audit finding F10.2, the "impossible --entities echo").
  const command = 'gh-delta --repo owner/repo --format json --detail --stale-after 24h';
  assert.equal(command.includes('--entities'), false, 'the rendered command must stay flag-free');
  assert.equal(command.includes('--stale-after 24h'), true, 'the stale fixture requires opt-in');
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

test('the visual generator renders every current output contract from real report data', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'gh-delta-visuals-'));
  try {
    execFileSync(process.execPath, ['tools/examples/generate-cast.mjs', outDir], {
      cwd: new URL('..', import.meta.url),
    });

    assert.deepEqual(readdirSync(outDir).sort(), [
      'common-loop.cast',
      'compact-output.cast',
      'demo.cast',
      'json-output.cast',
      'ndjson-output.cast',
      'schema-output.cast',
      'text-output.cast',
      'usage.cast',
    ]);

    const visible = (name) => {
      const rows = readFileSync(join(outDir, name), 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .map(JSON.parse);
      const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
      return rows
        .map((row) => row[2])
        .join('')
        .replaceAll(ansiColor, '');
    };

    assert.match(visible('compact-output.cast'), /--format compact/);
    assert.match(visible('compact-output.cast'), /"counts"/);
    assert.match(visible('compact-output.cast'), /"changed"/);
    assert.doesNotMatch(
      visible('compact-output.cast'),
      /"from": \{\r?\n/,
      'compact output must omit the full legacy from fingerprint',
    );

    assert.match(visible('ndjson-output.cast'), /--format ndjson \| jq/);
    assert.match(visible('ndjson-output.cast'), /"type": "delta"/);
    assert.match(visible('ndjson-output.cast'), /"type": "end"/);

    assert.match(visible('json-output.cast'), /--format json --detail/);
    assert.match(visible('json-output.cast'), /"from"/);
    assert.match(visible('json-output.cast'), /"to"/);

    assert.match(visible('schema-output.cast'), /schema --format compact/);
    assert.match(
      visible('schema-output.cast'),
      /jq '\{"\$schema": \."\$schema", title, schemaVersion, variants:/,
    );
    assert.match(
      visible('schema-output.cast'),
      /https:\/\/json-schema\.org\/draft\/2020-12\/schema/,
    );
    assert.match(visible('schema-output.cast'), /"title": "compact report"/);

    const commonLoopRows = readFileSync(join(outDir, 'common-loop.cast'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map(JSON.parse);
    const commonLoop = visible('common-loop.cast');
    assert.match(commonLoop, /while true; do\r\n> {3}gh-delta \\\r\n> {5}--repo owner\/repo/);
    assert.equal(
      commonLoop.includes(`${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[H`),
      false,
      'the loop must accumulate tick history and let the terminal scroll naturally',
    );
    assert.match(commonLoop, /--monitor-id pr-loop-60-secs/);
    assert.match(commonLoop, /alice opened PR #42/);
    assert.match(commonLoop, /CI started: lint, test-unit/);
    assert.match(commonLoop, /test-unit failed/);
    assert.match(commonLoop, /alice pushed fix 9f31c2a/);
    assert.match(commonLoop, /all checks passed/);
    assert.match(commonLoop, /head-changed, ci-changed/);
    assert.doesNotMatch(commonLoop, /ticks:/, 'the video must not add a fixed timeline banner');

    const quietTick = commonLoop.slice(
      commonLoop.indexOf('12:02 · tick 3'),
      commonLoop.indexOf('test-unit failed'),
    );
    assert.match(quietTick, /0 delta\(s\)/);
    assert.match(quietTick, /No GitHub deltas since the last snapshot\./);
    assert.doesNotMatch(quietTick, /ci-changed/);

    const lastQuietRow = commonLoopRows.findLastIndex((row) =>
      row[2].includes('No GitHub deltas since the last snapshot.'),
    );
    assert.notEqual(lastQuietRow, -1, 'the final quiet tick must be present');
    assert.ok(
      commonLoopRows.at(-1)[0] - commonLoopRows[lastQuietRow][0] >= 4.999,
      'the final quiet tick must remain visible for five seconds before the loop restarts',
    );

    const demoRows = readFileSync(join(outDir, 'demo.cast'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map(JSON.parse);
    const schemaRow = demoRows.findIndex((row) => row[2].includes('"schemaVersion"'));
    assert.notEqual(schemaRow, -1, 'the animated demo must reveal the compact JSON report');
    assert.ok(
      demoRows[schemaRow + 1][0] - demoRows[schemaRow][0] >= 0.099,
      'the animated demo must hold each JSON line for at least 100ms',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('animated SVGs do not render the blinking terminal cursor', () => {
  for (const name of ['demo.svg', 'common-loop.svg']) {
    const svg = readFileSync(new URL(`../docs/img/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      svg,
      /M0 0h1\.102v2\.171H0z/,
      `${name} must be exported with svg-term-cli --no-cursor`,
    );
  }
});

test('animated SVGs keep terminal frames stationary for crisp Chrome rendering', () => {
  for (const name of ['demo.svg', 'common-loop.svg']) {
    const svg = readFileSync(new URL(`../docs/img/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      svg,
      /translateX/,
      `${name} must not animate a horizontally translated frame reel`,
    );
    assert.match(
      svg,
      /visibility:hidden;animation:overlay-/,
      `${name} must switch stationary vector frames by discrete visibility`,
    );
    assert.match(svg, /<animate attributeName="width"/, `${name} must retain its progress bar`);
  }
});
