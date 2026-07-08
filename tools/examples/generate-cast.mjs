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
import { baselineReport, deltaReport, detailReport } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ?? join(HERE, 'build');

// ── ANSI ─────────────────────────────────────────────────────────────────
const GREEN = '\x1b[1;32m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';
const CMD = '\x1b[1;97m'; // bold bright white — what the operator types
const PROMPT = `${GREEN}❯${RESET} `;

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
  const r = clone(report);
  for (const d of r.deltas) enrichDelta(d, { legacyLine: true });
  return formatTextOutput({ code: 0, report: r, now: () => r.at });
}

function renderBaseline(report) {
  return formatTextOutput({ code: 0, report: clone(report), now: () => report.at });
}

// `--format json --detail`: summaryLine + legacy line + structured details.
function renderJson(report) {
  const r = clone(report);
  for (const d of r.deltas) enrichDelta(d, { summaryLine: true, legacyLine: true, details: true });
  const plain = `${JSON.stringify(r, null, 2)}\n`;
  // Colorize exactly the way an operator would read it in a shell.
  return execFileSync('jq', ['-C', '.'], { input: plain, encoding: 'utf8' });
}

// ── artifacts ──────────────────────────────────────────────────────────────
const baselineText = renderBaseline(baselineReport);
const deltaText = renderText(deltaReport);
const jsonColored = renderJson(detailReport);

// demo.cast — local shell loop: zero-config baseline, then the next scheduled tick.
const demo = cast({ width: 92, height: 22, title: 'gh-delta — quick demo' });
demo
  .prompt()
  .command('while :; do gh-delta --repo owner/repo; sleep 300; done')
  .enter()
  .out(`${GREY}… seeding baseline from GitHub${RESET}`, 0.8)
  .out('\r\x1b[2K', 0.6)
  .block(baselineText)
  .wait(1.4)
  .out(`${GREY}sleep 300  # in between, someone works on the repo${RESET}\r\n`, 0.4)
  .out(`${GREY}… fetching GitHub state${RESET}`, 0.8)
  .out('\r\x1b[2K', 0.6)
  .block(deltaText)
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

// json-output.cast — the `--format json --detail | jq` report (still).
// Width 100 so the longest lines (the resolved stateFile path and the
// summaryLine) render on one line instead of wrapping mid-token.
const json = cast({ width: 100, autoHeight: true, title: 'gh-delta — json output' });
json
  .prompt()
  .command('gh-delta --repo owner/repo --format json --detail ')
  .out(`${GREY}| jq${RESET}`)
  .enter()
  .block(jsonColored, 0.02)
  .prompt()
  .wait(0.8);

// ── write ────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const casts = {
  'demo.cast': demo,
  'usage.cast': usage,
  'text-output.cast': text,
  'json-output.cast': json,
};
for (const [name, c] of Object.entries(casts)) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, c.serialize());
  console.log(`wrote ${path}`);
}
