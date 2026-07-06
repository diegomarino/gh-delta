// Overlay a playback progress bar along the bottom edge of an animated demo SVG.
//
// svg-term animates the terminal via CSS but draws no progress indicator, so a
// long pause reads as "frozen". This injects a track rect plus a fill rect that
// grows 0 → full width over the loop duration (SMIL <animate>, so it works when
// the SVG is embedded as an <img>, as GitHub renders READMEs). The SVG stays
// text — the diff remains reviewable.
//
// Usage:  node tools/examples/add-progress-bar.mjs <demo.svg> <demo.cast>

import { readFileSync, writeFileSync } from 'node:fs';

const TRACK = '#282d38'; // slightly lighter than the asciinema background
const FILL = '#4ec9b0'; // teal accent, matches the prompt/detail greens
const BAR_H = 4;

const [svgPath, castPath] = process.argv.slice(2);
if (!svgPath || !castPath) {
  console.error('usage: add-progress-bar.mjs <svg> <cast>');
  process.exit(1);
}

const svg = readFileSync(svgPath, 'utf8');

const root = svg.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/);
if (!root) throw new Error('could not read width/height from the SVG root');
const width = Number(root[1]);
const height = Number(root[2]);

// Loop duration = last cast event timestamp, matching svg-term's own animation.
const rows = readFileSync(castPath, 'utf8').trim().split('\n').slice(1);
const dur = JSON.parse(rows[rows.length - 1])[0];

const y = (height - BAR_H).toFixed(2);
const bar =
  `<rect x="0" y="${y}" width="${width}" height="${BAR_H}" fill="${TRACK}"/>` +
  `<rect x="0" y="${y}" width="0" height="${BAR_H}" fill="${FILL}">` +
  `<animate attributeName="width" values="0;${width}" dur="${dur}s" ` +
  `repeatCount="indefinite" calcMode="linear"/></rect>`;

// Inject before the outermost closing tag so the bar sits above everything.
const out = svg.replace(/<\/svg>\s*$/, `${bar}</svg>`);
if (out === svg) throw new Error('could not find the closing </svg> to inject before');

writeFileSync(svgPath, out);
console.log(`progress bar added to ${svgPath} (dur ${dur}s)`);
