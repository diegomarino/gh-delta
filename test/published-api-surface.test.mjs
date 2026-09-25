// Guard: package.json#exports is the actual published ESM surface -- every
// symbol a mapped module exports is something a consumer can import today,
// documented or not. This has already gone wrong once (round 14):
// lib/watch.mjs re-exported three implementation helpers, one of them
// (writeTerminalIgnoredLocked) unsafe to call without a lock the published
// signature gives no hint of, none of them in docs/contract.md's own table.
//
// Same lesson as the last three review rounds: a guard that compares real
// output against a hand-copied expectation can stay green on exactly the
// drift it exists to catch. So neither side here is hand-written -- the
// "actual" side comes from really importing each exports-mapped module, and
// the "documented" side comes from actually parsing the Programmatic API
// Surface table in docs/contract.md, not a second list retyped from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

// Every subpath package.json#exports maps to a real .mjs file, except the
// literal `./package.json` passthrough (not a JS module, has no exports).
const PUBLISHED_SUBPATHS = Object.entries(packageJson.exports)
  .filter(([subpath]) => subpath !== './package.json')
  .map(([subpath, target]) => ({
    subpath: subpath.replace(/^\.\//, 'gh-delta/'),
    file: target.import,
  }));

// Parse docs/contract.md's own "## Programmatic API Surface" markdown table:
// each data row is `| `gh-delta/x`    | `sym1`, `sym2`, ...    | purpose |`.
// Stops at the first line that isn't a `|`-prefixed table row after the
// section starts, so this only ever reads the one real table, not prose
// below it that happens to mention a symbol name.
function parseDocumentedApiSurface() {
  const text = readFileSync(new URL('docs/contract.md', root), 'utf8');
  const heading = '## Programmatic API Surface';
  const start = text.indexOf(heading);
  assert.ok(start >= 0, 'docs/contract.md must have a Programmatic API Surface section');
  const lines = text.slice(start).split('\n');
  const documented = new Map();
  let sawHeaderSeparator = false;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (sawHeaderSeparator) break; // table ended
      continue; // still looking for the table
    }
    if (/^\|\s*-+\s*\|/.test(line)) {
      sawHeaderSeparator = true;
      continue;
    }
    if (!sawHeaderSeparator) continue; // header row itself, before the separator
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [subpathCell, symbolsCell] = cells;
    const subpathMatch = subpathCell.match(/^`(gh-delta\/[a-z-]+)`$/);
    if (!subpathMatch) continue;
    const symbols = [...symbolsCell.matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1]);
    documented.set(subpathMatch[1], symbols);
  }
  return documented;
}

test('every package.json#exports subpath is documented in the Programmatic API Surface table', () => {
  const documented = parseDocumentedApiSurface();
  assert.ok(documented.size > 0, 'must have parsed at least one documented subpath');
  const publishedNames = PUBLISHED_SUBPATHS.map((p) => p.subpath).sort();
  assert.deepEqual(
    publishedNames,
    [...documented.keys()].sort(),
    'package.json#exports and the documented table must name the exact same subpaths',
  );
});

for (const { subpath, file } of PUBLISHED_SUBPATHS) {
  test(`${subpath} exports exactly its documented symbols, nothing more`, async () => {
    const documented = parseDocumentedApiSurface();
    const expected = documented.get(subpath);
    assert.ok(expected, `${subpath} must have a row in the Programmatic API Surface table`);
    const modulePath = fileURLToPath(new URL(file, root));
    const actual = Object.keys(await import(modulePath));
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `${subpath}'s real exports must match the documented table exactly -- an ` +
        `undocumented export here is published API nobody decided to publish`,
    );
  });
}
