import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const path = (relative) => new URL(relative, root);
const examples = ['agent-worker-wait', 'coordinator-fanout', 'claude-code-hook', 'github-action'];

test('I-14 agent examples are executable deterministic local smokes', () => {
  for (const name of examples) {
    const script = fileURLToPath(path(`examples/${name}/run.sh`));
    accessSync(script, constants.X_OK);
    const output = execFileSync(script, [], { encoding: 'utf8' });
    assert.doesNotThrow(() => JSON.parse(output), `${name} must emit a local JSON proof`);
    const readme = readFileSync(path(`examples/${name}/README.md`), 'utf8');
    assert.match(readme, /run\.sh/);
    assert.match(readme, /GitHub|github/i);
  }
});

test('README is a short agent-first entrypoint and recipes cover ten decisions', () => {
  const readme = readFileSync(path('README.md'), 'utf8');
  assert.ok(
    readme.trim().split(/\s+/).length <= 1052,
    'README must remain at most half its prior 2104 words',
  );
  assert.match(readme, /## Install/);
  assert.match(readme, /## Quick start/);
  assert.match(readme, /## What an agent usually does/);
  assert.match(readme, /npx skills add diegomarino\/gh-delta/);
  const recipes = readFileSync(path('docs/recipes.md'), 'utf8');
  assert.equal([...recipes.matchAll(/^\| [^|]+ \| `[^`]*gh-delta/gm)].length, 10);
  for (const line of recipes.matchAll(/^\| [^|]+ \| `([^`]+)`/gm))
    assert.match(line[1], /(?:^|; )gh-delta /, 'every recipe presents a CLI command');
  assert.match(recipes, /PR_NUMBER=42; gh-delta wait[^`]+--number "\$PR_NUMBER"/);
  assert.match(readme, /PR_NUMBER=42[\s\S]+--number "\$PR_NUMBER"/);
});

test('I-14 examples bind cursors, target one PR, and preserve their exit contracts', () => {
  const worker = readFileSync(path('examples/agent-worker-wait/README.md'), 'utf8');
  assert.match(worker, /PR_NUMBER=42/);
  assert.match(worker, /--number "\$PR_NUMBER"/);

  const coordinator = readFileSync(path('examples/coordinator-fanout/README.md'), 'utf8');
  assert.match(
    coordinator,
    /if \[ ! -f "\$cursor" \]; then[\s\S]+gh-delta cursor set "\$cursor" 0 --log-file "\$LOG_FILE"/,
  );
  assert.match(coordinator, /gh-delta read --cursor "\$cursor" --number 42 --advance/);
  assert.doesNotMatch(coordinator, /read --log-file/);

  const hook = readFileSync(path('examples/claude-code-hook/README.md'), 'utf8');
  for (const code of ['0', '10', '1', '2']) assert.match(hook, new RegExp(`${code}[^)\\n]*`));
  assert.match(hook, /10\) exit 0/);
  assert.match(hook, /2\).*exit 2/);
});

test('GitHub Action shape restores/saves state and exposes exhaustive outputs', () => {
  const action = readFileSync(path('examples/github-action/README.md'), 'utf8');
  assert.match(action, /actions\/cache\/restore@v4/);
  assert.match(action, /actions\/cache\/save@v4/);
  assert.match(action, /--monitor-id actions-cache/);
  assert.match(action, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(action, /permissions:[\s\S]+pull-requests: read/);
  assert.match(
    action,
    /concurrency:[\s\S]+group: gh-delta-\$\{\{ github\.repository \}\}[\s\S]+cancel-in-progress: false/,
  );
  assert.match(action, /changed: \$\{\{ steps\.tick\.outputs\.changed \}\}/);
  assert.match(action, /report: \$\{\{ steps\.tick\.outputs\.report \}\}/);
  assert.match(action, /report<<GH_DELTA_REPORT/);
  assert.match(action, /0\|10\) exit 0/);
  assert.match(action, /1\).*exit 0/);
  assert.match(action, /2\).*exit 2/);
  assert.match(action, /\*\).*exit 1/);
});
