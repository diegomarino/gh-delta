// Make svg-term animations render sharply in Chromium-based browsers.
//
// svg-term lays every terminal frame beside the previous one (`<svg x="…">`)
// and animates their parent with `transform: translateX(…)`. Chromium promotes
// that very wide moving reel to a raster layer, so otherwise stationary SVG
// text becomes soft at README display sizes. This postprocessor preserves the
// same vector frames and timing while changing only how a frame is selected:
//
// - `x`: removed from selected frame `<svg>` elements so every frame occupies
//   the same origin instead of a different position on a horizontal reel.
// - `visibility`: hidden by default, then made visible for exactly its original
//   keyframe interval. Unlike `opacity`, hidden frames do not remain paintable.
// - `animation`: one discrete CSS animation per selected frame. `step-end`
//   prevents interpolation or cross-fades between terminal states.
// - `@keyframes`: derived from svg-term's original percentage timestamps, so
//   typing cadence, pauses, final holds, and the independently animated progress
//   bar remain synchronized.
// - `transform: translateX`: removed entirely; avoiding this composited moving
//   layer is the reason text remains crisp in Chrome.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function keyframeBlock(svg) {
  const start = svg.indexOf('@keyframes ');
  if (start === -1) throw new Error('svg-term keyframes not found');
  const open = svg.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < svg.length; index++) {
    if (svg[index] === '{') depth++;
    if (svg[index] === '}') depth--;
    if (depth === 0) return { start, end: index + 1, css: svg.slice(start, index + 1) };
  }
  throw new Error('unterminated svg-term keyframes');
}

export function stabilizeSvgAnimation(svg) {
  const duration = svg.match(/animation-duration:([\d.]+)s/)?.[1];
  const keyframes = keyframeBlock(svg);
  const reel = svg.match(
    /<g style="animation-duration:[^"]+"><svg width="\d+">((?:<svg(?: x="\d+")?>[\s\S]*?<\/svg>)+)<\/svg><\/g>/,
  );
  if (!duration || !reel) throw new Error('unsupported svg-term animated reel');

  const steps = [
    ...keyframes.css.matchAll(/([\d.]+%|to)\{transform:translateX\((-?\d+)px\)\}/g),
  ].map(([, at, offset]) => ({
    at: at === 'to' ? 100 : Number.parseFloat(at),
    x: Math.abs(Number(offset)),
  }));
  if (steps.length < 2) throw new Error('svg-term animation has too few frames');

  const frames = [...reel[1].matchAll(/<svg(?: x="(\d+)")?>[\s\S]*?<\/svg>/g)];
  const frameAt = new Map(frames.map((match) => [Number(match[1] ?? 0), match[0]]));
  const rules = [];
  const overlays = [];

  // The terminal state at 100% is the instantaneous loop boundary. The prior
  // frame already remains visible through 100%, so emitting it would add a
  // zero-duration duplicate rather than a viewable state.
  for (let index = 0; index < steps.length - 1; index++) {
    const start = steps[index].at;
    const end = steps[index + 1].at;
    const frame = frameAt.get(steps[index].x);
    if (!frame) throw new Error(`svg-term frame at x=${steps[index].x} not found`);

    const name = `overlay-${index}`;
    const before = Math.max(0, start - 0.001);
    const until = Math.max(start, end - 0.001);
    rules.push(
      `@keyframes ${name}{` +
        `${start === 0 ? '' : `0%,${before}%{visibility:hidden}`}` +
        `${start}%{visibility:visible}${until}%{visibility:visible}` +
        `${end}%{visibility:hidden}100%{visibility:hidden}}`,
    );
    overlays.push(
      frame.replace(
        /^<svg(?: x="\d+")?>/,
        `<svg style="visibility:hidden;animation:${name} ${duration}s step-end infinite">`,
      ),
    );
  }

  return svg.replace(keyframes.css, rules.join('')).replace(reel[0], `<g>${overlays.join('')}</g>`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error('usage: stabilize-svg-animation.mjs <animated.svg>');
  writeFileSync(path, stabilizeSvgAnimation(readFileSync(path, 'utf8')));
  console.log(`stationary vector frames added to ${path}`);
}
