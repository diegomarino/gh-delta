import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cli from '../lib/cli.mjs';

test('CLI compatibility facade exposes exactly the existing seven exports', () => {
  assert.deepEqual(Object.keys(cli).sort(), [
    'PARSER_OPTIONS_BY_COMMAND',
    'REPORT_SCHEMA_VERSION',
    'enrichDelta',
    'parseCli',
    'run',
    'runCommand',
    'runWithOutpost',
  ]);
});

test('CLI facade contains only explicit re-exports', () => {
  const source = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const statements = source.replace(/\/\/[^\n]*/g, '').trim();
  assert.match(statements, /^(export \{[^}]+\} from '[^']+';\s*)+$/);
});

test('run stays synchronous and evaluates detector dependencies only after dispatch', () => {
  let detectorReads = 0;
  const deps = {
    get fetchPRs() {
      detectorReads += 1;
      return () => assert.fail('help must not fetch GitHub');
    },
    now: () => '2026-01-01T00:00:00.000Z',
  };
  const schema = cli.run(['schema', '--help', '--invalid'], deps);
  assert.equal(schema.code, 0);
  assert.equal(typeof schema.then, 'undefined');
  assert.equal(detectorReads, 0);

  const detector = cli.run(['--help', '--repo'], deps);
  assert.equal(detector.code, 0);
  assert.equal(typeof detector.then, 'undefined');
  assert.equal(detectorReads, 1);
  assert.equal(detector.report, cli.parseCli(['--help']).help);
});
