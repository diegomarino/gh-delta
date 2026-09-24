// Generate asciicast v2 files for the README example artifacts.
//
// Every terminal line is captured verbatim from the *real* renderers
// (lib/text-output.mjs, JSON.stringify, and jq -C for color) fed the frozen
// fixtures — so the demo is byte-identical to a live `gh-delta` run without a
// network or a `gh` binary. Timings come from a seeded LCG, so regenerating on
// an unchanged fixture produces an identical cast (a stable git diff).
//
// Usage:
//   node tools/examples/generate-cast.mjs [outDir]   # default: tools/examples/build
//
// Cast → SVG conversion lives in render.sh (svg-term).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTextOutput } from '../../lib/text-output.mjs';
import { enrichDelta } from '../../lib/cli.mjs';
import { compactReport, ndjsonReport } from '../../lib/compact-output.mjs';
import { schemaFor } from '../../lib/schema.mjs';
import { deltaId, deltaIdentity } from '../../lib/fingerprint.mjs';
import { diffFingerprint } from '../../lib/diff.mjs';
import { deltaSummary } from '../../lib/summary.mjs';
import { baselineReport, deltaReport, detailReport } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ?? join(HERE, 'build');

// ── ANSI ─────────────────────────────────────────────────────────────────
const GREEN = '\x1b[1;32m';
const AMBER = '\x1b[1;33m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';
const CMD = '\x1b[1;97m'; // bold bright white — what the operator types
const PROMPT = `${GREEN}❯${RESET} `;
const CONTINUATION_PROMPT = `${GREY}>${RESET} `;

// ── deterministic pseudo-random for stable timing jitter ───────────────────
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ── cast builder ───────────────────────────────────────────────────────────
function cast({ width, height, title, autoHeight = false }) {
  const events = [];
  let t = 0;
  let rows = 0; // newlines emitted, for autoHeight (still frames must not scroll)
  const push = (data, dt = 0) => {
    t += dt;
    events.push([Number(t.toFixed(3)), 'o', data]);
    rows += (data.match(/\n/g) ?? []).length;
  };
  const api = {
    wait: (dt) => {
      t += dt;
      return api;
    },
    out(data, dt = 0) {
      push(data, dt);
      return api;
    },
    prompt() {
      return api.out(PROMPT, 0.4);
    },
    // A command the operator types: bold bright white, visually distinct from output.
    command(text, cps = 0.045) {
      api.out(CMD);
      for (const ch of text) api.out(ch, cps + rand() * 0.03);
      return api.out(RESET);
    },
    type(text, cps = 0.045) {
      for (const ch of text) api.out(ch, cps + rand() * 0.03);
      return api;
    },
    enter() {
      return api.out('\r\n', 0.12);
    },
    // Emit a multi-line block (renderer output) as one paced reveal.
    block(text, dt = 0.05) {
      for (const lineText of text.split('\n')) api.out(lineText + '\r\n', dt);
      return api;
    },
    serialize() {
      const header = {
        version: 2,
        width,
        // Stills render the final frame; size the terminal so nothing scrolls off.
        height: autoHeight ? rows + 3 : height,
        title,
        env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
      };
      return [header, ...events].map((row) => JSON.stringify(row)).join('\n') + '\n';
    },
  };
  return api;
}

// ── enrichment mirrors run()'s flag wiring (lib/cli.mjs) ────────────────────
function clone(report) {
  return JSON.parse(JSON.stringify(report));
}

function renderText(report) {
  return formatTextOutput({ code: 0, report: clone(report), now: () => report.detectedAt });
}

function renderBaseline(report) {
  return formatTextOutput({ code: 0, report: clone(report), now: () => report.detectedAt });
}

// Snapshot items store `{ fingerprint, context, meta }`; wrap a raw compared-
// fields fragment (e.g. `pending`/`failed` below) into that shape.
const loopItem = (fingerprint) =>
  fingerprint && {
    fingerprint,
    context: { title: 'Add billing webhook', headRefName: 'feature/billing-webhook' },
    meta: {
      seenAt: null,
      changedAt: null,
      ticksSinceChange: 0,
      missingTicks: 0,
      staleEmittedFor: null,
    },
  };

function loopDelta(classes, from, to) {
  const delta = {
    repo: 'owner/repo',
    entity: 'pr',
    number: 42,
    context: { title: 'Add billing webhook', headRefName: 'feature/billing-webhook' },
    classes,
    from: loopItem(from),
    to: loopItem(to),
  };
  delta.id = deltaId(deltaIdentity('owner/repo', delta));
  delta.changed = diffFingerprint(delta.from?.fingerprint, delta.to?.fingerprint);
  delta.summary = deltaSummary(delta);
  // Public contract: from/to are the bare fingerprint, not the full item --
  // see lib/cli.mjs's matching strip step.
  delta.from = delta.from?.fingerprint ?? null;
  delta.to = delta.to?.fingerprint ?? null;
  return delta;
}

function loopReport(detectedAt, delta = null, baseline = false) {
  return {
    schemaVersion: 2,
    detectedAt,
    monitorId: 'pr-loop-60-secs',
    entities: ['pr'],
    repos: ['owner/repo'],
    results: [
      {
        repo: 'owner/repo',
        baseline,
        repoSource: 'flag',
        stateFile: '.gh-delta/repo-owner%2Frepo__monitor-pr-loop-60-secs__pr.json',
        rateLimit: null,
      },
    ],
    deltas: delta ? [delta] : [],
    filteredDeltas: 0,
    warnings: [],
    summary: delta ? '1 delta(s)' : baseline ? 'baseline established: 0 PRs' : '0 delta(s)',
  };
}

// `--format json --detail`: summaryLine + legacy line + structured details.
function colorJson(value, args = ['-C', '.']) {
  const plain = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  // Colorize exactly the way an operator would read it in a shell.
  return execFileSync('jq', args, { input: plain, encoding: 'utf8' });
}

function renderJson(report) {
  const r = clone(report);
  for (const d of r.deltas) enrichDelta(d, { summaryLine: true, details: true });
  return colorJson(r);
}

// ── artifacts ──────────────────────────────────────────────────────────────
const baselineText = renderBaseline(baselineReport);
const deltaText = renderText(deltaReport);
const jsonColored = renderJson(detailReport);
const compactColored = colorJson(compactReport(clone(detailReport), 10));
const ndjsonColored = colorJson(ndjsonReport(clone(detailReport), 10));
const compactSchema = schemaFor('compact');
const schemaColored = colorJson({
  $schema: compactSchema.$schema,
  title: compactSchema.title,
  schemaVersion: compactSchema.schemaVersion,
  variants: [compactSchema.required],
});

// demo.cast — baseline followed by the agent-oriented compact delta report.
const demo = cast({ width: 92, height: 22, title: 'gh-delta — quick demo' });
demo
  .prompt()
  .command('gh-delta --repo owner/repo')
  .enter()
  .out(`${GREY}… seeding baseline from GitHub${RESET}`, 0.8)
  .out('\r\x1b[2K', 0.6)
  .block(baselineText)
  .wait(1.4)
  .out(`${GREY}# later, after GitHub state changes${RESET}\r\n`, 0.4)
  .prompt()
  .command('gh-delta --repo owner/repo --format compact | jq')
  .enter()
  .out(`${GREY}… fetching GitHub state${RESET}`, 0.8)
  .out('\r\x1b[2K', 0.6)
  .block(compactColored, 0.1)
  // A no-op event 5s later extends the stream so the final frame is held ~5s
  // before the loop restarts (a bare `wait` moves the clock but emits no event,
  // so svg-term — which derives duration from the last event — would ignore it).
  .out('\x1b[0m', 5);

// usage.cast — the minimal zero-config invocation + baseline seed (still).
const usage = cast({ width: 76, autoHeight: true, title: 'gh-delta — usage' });
usage
  .prompt()
  .command('gh-delta --repo owner/repo')
  .enter()
  .block(baselineText, 0.03)
  .prompt()
  .wait(0.8);

// text-output.cast — the `--format text` delta report (still).
const text = cast({ width: 92, autoHeight: true, title: 'gh-delta — text output' });
text
  .prompt()
  .command('gh-delta --repo owner/repo')
  .enter()
  .block(deltaText, 0.03)
  .prompt()
  .wait(0.8);

// json-output.cast — the `--format json --detail --stale-after 24h | jq` report (still).
// Width 100 so the longest lines (the resolved stateFile path and the
// summaryLine) render on one line instead of wrapping mid-token.
const json = cast({ width: 100, autoHeight: true, title: 'gh-delta — json output' });
json
  .prompt()
  .command('gh-delta --repo owner/repo --format json --detail --stale-after 24h ')
  .out(`${GREY}| jq${RESET}`)
  .enter()
  .block(jsonColored, 0.02)
  .prompt()
  .wait(0.8);

// compact-output.cast — bounded JSON for agent context.
const compact = cast({ width: 100, autoHeight: true, title: 'gh-delta — compact output' });
compact
  .prompt()
  .command('gh-delta --repo owner/repo --format compact ')
  .out(`${GREY}| jq${RESET}`)
  .enter()
  .block(compactColored, 0.02)
  .prompt()
  .wait(0.8);

// ndjson-output.cast — one compact record per line plus the terminal end record.
const ndjson = cast({ width: 100, autoHeight: true, title: 'gh-delta — NDJSON output' });
ndjson
  .prompt()
  .command('gh-delta --repo owner/repo --format ndjson ')
  .out(`${GREY}| jq${RESET}`)
  .enter()
  .block(ndjsonColored, 0.04)
  .prompt()
  .wait(0.8);

// schema-output.cast — concise inspection of the full generated compact schema.
const schema = cast({ width: 100, autoHeight: true, title: 'gh-delta — compact schema' });
schema
  .prompt()
  .command(
    'gh-delta schema --format compact | jq \'{"$schema": ."$schema", title, schemaVersion, variants: [.required]}\'',
  )
  .enter()
  .block(schemaColored, 0.03)
  .prompt()
  .wait(0.8);

// common-loop.cast — a readable scheduled loop from PR creation through green CI.
const commonLoop = cast({ width: 110, height: 24, title: 'gh-delta — common PR loop' });
const showTick = (label, report, hold = 3.2) => {
  commonLoop
    .out('\r\n', 0.2)
    .out(`${GREY}${label} · monitor pr-loop-60-secs${RESET}\r\n`, 0.1)
    .block(renderText(report), 0.08)
    .wait(hold);
};
const showActivity = (lines) => {
  commonLoop
    .out('\r\n', 0.2)
    .out(`${AMBER}[GitHub activity]${RESET}\r\n`, 0.1)
    .block(lines.map((line) => `${AMBER}${line}${RESET}`).join('\n'), 0.12)
    .wait(2.8);
};

const pending = { state: 'OPEN', head: 'a1b2c3d', ci: 'pending' };
const failed = { state: 'OPEN', head: 'a1b2c3d', ci: 'failed' };
const fixPending = { state: 'OPEN', head: '9f31c2a', ci: 'pending' };
const green = { state: 'OPEN', head: '9f31c2a', ci: 'green' };

commonLoop
  .prompt()
  .command('while true; do', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('  gh-delta \\', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('    --repo owner/repo \\', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('    --monitor-id pr-loop-60-secs \\', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('    --state-dir .gh-delta \\', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('    --entities pr \\', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('    --format text', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('  sleep 60', 0.018)
  .enter()
  .out(CONTINUATION_PROMPT)
  .command('done', 0.018)
  .enter()
  .wait(2.5);
showTick('12:00 · tick 1', loopReport('2026-09-21T12:00:00.000Z', null, true));
showActivity(['alice opened PR #42 "Add billing webhook"', 'CI started: lint, test-unit']);
showTick(
  '12:01 · tick 2',
  loopReport('2026-09-21T12:01:00.000Z', loopDelta(['new'], null, pending)),
);
showTick('12:02 · tick 3', loopReport('2026-09-21T12:02:00.000Z'));
showActivity(['test-unit failed']);
showTick(
  '12:03 · tick 4',
  loopReport('2026-09-21T12:03:00.000Z', loopDelta(['ci-changed'], pending, failed)),
);
showActivity(['alice pushed fix 9f31c2a']);
showTick(
  '12:04 · tick 5',
  loopReport(
    '2026-09-21T12:04:00.000Z',
    loopDelta(['head-changed', 'ci-changed'], failed, fixPending),
  ),
);
showActivity(['all checks passed']);
showTick(
  '12:05 · tick 6',
  loopReport('2026-09-21T12:05:00.000Z', loopDelta(['ci-changed'], fixPending, green)),
);
showTick('12:06 · tick 7', loopReport('2026-09-21T12:06:00.000Z'), 5);
// Materialize the final hold: svg-term derives its loop duration from the last
// event timestamp, so a trailing wait alone would be discarded on serialize.
commonLoop.out('\x1b[0m');

// ── write ────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const casts = {
  'demo.cast': demo,
  'usage.cast': usage,
  'text-output.cast': text,
  'json-output.cast': json,
  'compact-output.cast': compact,
  'ndjson-output.cast': ndjson,
  'schema-output.cast': schema,
  'common-loop.cast': commonLoop,
};
for (const [name, c] of Object.entries(casts)) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, c.serialize());
  console.log(`wrote ${path}`);
}
