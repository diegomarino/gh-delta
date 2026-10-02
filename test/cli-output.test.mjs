// CLI contract tests: --omit-end, templates, and cursor-safe read rendering.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basePr,
  item,
  openFp,
  NOOP_LOCK_DEPS,
  RATE_LIMIT,
  DEFAULT_OLD_META,
  deps,
  depsForSecondTick,
} from './helpers/cli-fixtures.mjs';
import { runCommand } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { readWatch } from '../lib/watch.mjs';
import { setCursorAtomic } from '../lib/deltalog.mjs';

test('omit-end config reaches rendering without the flag on argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-config-'));
  writeFileSync(
    join(dir, '.gh-delta.json'),
    JSON.stringify({ format: 'ndjson', 'omit-end': true }),
  );
  const quiet = await runCommand(['--repo', 'o/r', '--state-file', join(dir, 'state.json')], {
    ...NOOP_LOCK_DEPS,
    cwd: () => dir,
    fetchPRs: () => ({ rows: [], rateLimit: null }),
    fetchIssues: () => ({ rows: [], rateLimit: null }),
    now: () => '2026-07-01T12:00:00Z',
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.output, '');
  assert.equal(quiet.stderr, '');
});

test('omit-end with json format exits 2 before fetch and keeps the json error renderer', async () => {
  let fetched = false;
  const result = await runCommand(['--repo', 'o/r', '--format', 'json', '--omit-end'], {
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: null };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(fetched, false);
  assert.equal(result.output.includes('gh-delta: error'), false);
  assert.match(result.output, /omit-end requires --format ndjson/);
});

test('wait rejects omit-end as an unknown option', async () => {
  const result = await runCommand(['wait', '--timeout', '1s', '--omit-end', '--repo', 'o/r']);
  assert.equal(result.code, 2);
  assert.match(result.output, /omit-end|Unknown option/i);
});

test('read and schema reject omit-end as an unknown option', async () => {
  const read = await runCommand(['read', '--cursor', '/tmp/c.json', '--omit-end']);
  assert.equal(read.code, 2);
  assert.match(read.output, /omit-end|Unknown option/i);
  const schema = await runCommand(['schema', '--format', 'ndjson', '--omit-end']);
  assert.equal(schema.code, 2);
  assert.match(schema.output, /omit-end|Unknown option/i);
});

test('explicit ndjson omit-end pair diagnoses a config load failure on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-bad-config-'));
  writeFileSync(join(dir, '.gh-delta.json'), '{');
  const diagnosed = await runCommand(['--repo', 'o/r', '--format', 'ndjson', '--omit-end'], {
    cwd: () => dir,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(diagnosed.code, 2);
  assert.equal(diagnosed.output, '');
  assert.match(diagnosed.stderr, /^gh-delta: error \{/);
  const ordinary = await runCommand(['--repo', 'o/r'], {
    cwd: () => dir,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(ordinary.code, 2);
  assert.match(ordinary.output, /invalid JSON/);
  assert.equal(ordinary.stderr ?? '', '');
});

test('omit-end env and project precedence and boolean config type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-prec-'));
  writeFileSync(
    join(dir, '.gh-delta.json'),
    JSON.stringify({ format: 'ndjson', 'omit-end': true }),
  );
  const fromEnv = await runCommand(['--repo', 'o/r', '--state-file', join(dir, 'state.json')], {
    ...NOOP_LOCK_DEPS,
    cwd: () => dir,
    fetchPRs: () => ({ rows: [], rateLimit: null }),
    fetchIssues: () => ({ rows: [], rateLimit: null }),
    now: () => '2026-07-01T12:00:00Z',
    env: { GH_DELTA_NO_REGISTRY: '1', GH_DELTA_OMIT_END: 'false' },
  });
  assert.equal(fromEnv.code, 0);
  assert.match(fromEnv.output, /"type":"end"/);

  const envOn = await runCommand(
    ['--repo', 'o/r', '--format', 'ndjson', '--state-file', join(dir, 'state-env.json')],
    {
      ...NOOP_LOCK_DEPS,
      cwd: () => dir,
      homedir: () => dir,
      fetchPRs: () => ({ rows: [], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => '2026-07-01T12:00:00Z',
      env: { GH_DELTA_NO_REGISTRY: '1', GH_DELTA_OMIT_END: 'true' },
      configReadFileSync: () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    },
  );
  assert.equal(envOn.code, 0);
  assert.equal(envOn.output, '');

  const stringKey = mkdtempSync(join(tmpdir(), 'gd-omit-end-str-'));
  writeFileSync(join(stringKey, '.gh-delta.json'), JSON.stringify({ 'omit-end': 'true' }));
  const badType = await runCommand(['--repo', 'o/r'], {
    cwd: () => stringKey,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(badType.code, 2);
  assert.match(badType.output, /omit-end must be a boolean/);
});

test('omit-end invalid class uses stderr diagnostics', async () => {
  const badClass = await runCommand(
    ['--repo', 'o/r', '--format', 'ndjson', '--omit-end', '--only-classes', 'bogus'],
    { env: { GH_DELTA_NO_REGISTRY: '1' } },
  );
  assert.equal(badClass.code, 2);
  assert.equal(badClass.output, '');
  assert.match(badClass.stderr, /"kind":"config"/);
  assert.match(badClass.stderr, /bogus/);
});

test('help with omit-end and a broken project config still prints help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-help-'));
  writeFileSync(join(dir, '.gh-delta.json'), '{');
  const help = await runCommand(['--help', '--omit-end'], {
    cwd: () => dir,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(help.code, 0);
  assert.match(help.output, /deterministic detection pass/);
});

test('wait nested ticks do not inherit omit-end from GH_DELTA_OMIT_END', async () => {
  let clock = 0;
  const result = await runCommand(
    [
      'wait',
      '--timeout',
      '1s',
      '--format',
      'json',
      '--repo',
      'o/r',
      '--until',
      'ci-changed',
      '--state-file',
      '/tmp/omit-end-wait.json',
    ],
    {
      ...NOOP_LOCK_DEPS,
      now: () => '2026-07-01T12:00:00Z',
      clock: () => {
        clock += 1000;
        return clock;
      },
      sleep: async () => {},
      fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => ({ pr: {}, issue: {}, meta: DEFAULT_OLD_META }),
      writeSnapshotAtomic: () => {},
      env: { GH_DELTA_NO_REGISTRY: '1', GH_DELTA_OMIT_END: 'true' },
    },
  );
  assert.notEqual(result.code, 2);
  assert.equal(result.output.includes('--omit-end requires --format ndjson'), false);
});

test('omit-end multi-repo keeps successful deltas and permanent exit 2', async () => {
  const snapshots = new Map();
  const changed = { ...basePr, number: 2, title: 'two', updatedAt: '2026-07-01T11:00:00Z' };
  const result = await runCommand(
    [
      '--repo',
      'a/one,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/omit-end-multi-perm',
      '--entities',
      'pr',
      '--format',
      'ndjson',
      '--omit-end',
    ],
    {
      ...NOOP_LOCK_DEPS,
      now: () => '2026-07-01T12:00:00Z',
      readSnapshot: (path) => {
        if (path.includes('a%2Fone')) throw new Error('invalid snapshot JSON');
        return (
          snapshots.get(path) ?? {
            pr: { 2: item(prFingerprint({ ...changed, updatedAt: '2026-07-01T10:00:00Z' })) },
            issue: {},
            meta: { ...DEFAULT_OLD_META, repo: 'b/two' },
          }
        );
      },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: () => ({ rows: [changed], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(result.code, 2);
  const lines = result.output.trimEnd() === '' ? [] : result.output.trimEnd().split('\n');
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.equal(record.type, 'delta');
  }
  assert.match(result.stderr, /gh-delta: error /);
  assert.match(result.stderr, /"repo":"a\/one"/);
  assert.match(result.stderr, /"hint":/);
});

test('omit-end multi-repo transient failure exits 1 and keeps the other repo delta', async () => {
  const snapshots = new Map();
  const changed = { ...basePr, number: 2, title: 'two', updatedAt: '2026-07-01T11:00:00Z' };
  const result = await runCommand(
    [
      '--repo',
      'a/one,b/two',
      '--monitor-id',
      'i9',
      '--state-dir',
      '/tmp/omit-end-multi-trans',
      '--entities',
      'pr',
      '--format',
      'ndjson',
      '--omit-end',
    ],
    {
      ...NOOP_LOCK_DEPS,
      now: () => '2026-07-01T12:00:00Z',
      readSnapshot: (path) =>
        snapshots.get(path) ?? {
          pr: path.includes('b%2Ftwo')
            ? { 2: item(prFingerprint({ ...changed, updatedAt: '2026-07-01T10:00:00Z' })) }
            : {},
          issue: {},
          meta: DEFAULT_OLD_META,
        },
      writeSnapshotAtomic: (path, value) => snapshots.set(path, value),
      fetchPRs: (repo) => {
        if (repo === 'a/one') throw new Error('temporary GitHub failure');
        return { rows: [changed], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(result.code, 1);
  const lines = result.output.trimEnd().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'delta');
  assert.equal(
    lines.some((line) => JSON.parse(line).type === 'end'),
    false,
  );
  assert.match(result.stderr, /"repo":"a\/one"/);
});

test('omit-end outpost warning is on stderr once without an end line', async () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: { 42: item(openFp) },
      issue: {},
    },
  });
  d.outpostFetch = async () => ({ ok: false, status: 500 });
  const result = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/omit-end-outpost.json',
      '--format',
      'ndjson',
      '--omit-end',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(result.code, 10);
  const lines = result.output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(
    lines.some((row) => row.type === 'end'),
    false,
  );
  assert.ok(lines.every((row) => row.type === 'delta'));
  const warnings = result.stderr.trimEnd().split('\n');
  assert.equal(warnings.length, 1);
  assert.match(result.stderr, /^gh-delta: warning /);
  assert.match(result.stderr, /HTTP 500/);
});

test('template format renders one line and does not fetch when the path is unknown', async () => {
  let fetched = false;
  const bad = await runCommand(
    ['--repo', 'o/r', '--format', 'template', '--template', '{summary.typo}'],
    {
      fetchPRs: () => {
        fetched = true;
        return { rows: [], rateLimit: null };
      },
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(bad.code, 2);
  assert.equal(bad.output, '');
  assert.match(bad.stderr, /^gh-delta: error \{/);
  assert.equal(fetched, false);
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-cli-'));
  const d = depsForSecondTick();
  const quiet = await runCommand(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--format',
      'template',
      '--template',
      '{entity} #{number} [{classes}]',
    ],
    d,
  );
  assert.equal(quiet.code, 0);
  assert.equal(quiet.output, '');
  const ok = await runCommand(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--format',
      'template',
      '--template',
      '{entity} #{number} [{classes}]',
    ],
    d,
  );
  assert.equal(ok.code, 10);
  assert.match(ok.output, /^pr #42 \[[^\]]+\]\n$/);
  assert.equal(ok.output.includes('\n', ok.output.indexOf('\n') + 1), false);
});

test('template format file hash pins raw bytes and reads the file once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-hash-'));
  const path = join(dir, 'line.txt');
  const raw = '{entity}\n';
  writeFileSync(path, raw);
  const digest = createHash('sha256').update(Buffer.from(raw)).digest('hex');
  let reads = 0;
  const d = deps([[{ ...basePr, headSha: 'sha2' }]], {
    existing: { pr: { 42: item(openFp) }, issue: {} },
  });
  const ok = await runCommand(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--format',
      'template',
      '--template-file',
      path,
      '--template-sha256',
      digest,
    ],
    {
      ...d,
      readFileSync: (file, encoding) => {
        if (file === path) {
          reads += 1;
          return Buffer.from(raw);
        }
        return readFileSync(file, encoding);
      },
    },
  );
  assert.equal(ok.code, 10);
  assert.equal(ok.output, 'pr\n');
  assert.equal(reads, 1);
});

test('template format read advances only after a valid template', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-read-'));
  const stateFile = join(dir, 'state.json');
  const d = depsForSecondTick();
  await runCommand(['--repo', 'o/r', '--state-file', stateFile, '--log', '--entities', 'pr'], d);
  const tick = await runCommand(
    ['--repo', 'o/r', '--state-file', stateFile, '--log', '--entities', 'pr'],
    d,
  );
  assert.equal(tick.code, 10);
  const logFile = tick.report.results[0].logFile;
  const cursor = join(dir, 'cursor.json');
  setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
  const before = readFileSync(cursor);
  const bad = await runCommand(
    [
      'read',
      '--cursor',
      cursor,
      '--advance',
      '--format',
      'template',
      '--template',
      '{summary.typo}',
    ],
    { env: { GH_DELTA_NO_REGISTRY: '1' } },
  );
  assert.equal(bad.code, 2);
  assert.equal(bad.output, '');
  assert.match(bad.stderr, /^gh-delta: error \{/);
  assert.deepEqual(readFileSync(cursor), before);
  const ok = await runCommand(
    [
      'read',
      '--cursor',
      cursor,
      '--advance',
      '--format',
      'template',
      '--template',
      '{entity} #{number}',
    ],
    { env: { GH_DELTA_NO_REGISTRY: '1' } },
  );
  assert.equal(ok.code, 10);
  assert.equal(ok.output, 'pr #42\n');
  const advanced = JSON.parse(readFileSync(cursor, 'utf8'));
  assert.notEqual(advanced.seq, 0);
});

test('template format with json and missing source are ordinary or diagnostic errors before fetch', async () => {
  let fetched = false;
  const fetchDeps = {
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: null };
    },
    env: { GH_DELTA_NO_REGISTRY: '1' },
  };
  const jsonPlus = await runCommand(
    ['--repo', 'o/r', '--format', 'json', '--template', '{id}'],
    fetchDeps,
  );
  assert.equal(jsonPlus.code, 2);
  assert.equal(jsonPlus.stderr, '');
  assert.match(jsonPlus.output, /\{/);
  assert.doesNotMatch(jsonPlus.output, /gh-delta: error/);
  assert.equal(fetched, false);
  fetched = false;
  const missing = await runCommand(['--repo', 'o/r', '--format', 'template'], fetchDeps);
  assert.equal(missing.code, 2);
  assert.equal(missing.output, '');
  assert.match(missing.stderr, /^gh-delta: error \{/);
  assert.equal(fetched, false);
  const wait = await runCommand(
    ['wait', '--format', 'template', '--timeout', '1s', '--until', 'new'],
    {
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(wait.code, 2);
});

test('template format prints a diagnostic when a tick fails after compilation', async () => {
  const result = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'm',
      '--state-file',
      '/tmp/x.json',
      '--format',
      'template',
      '--template',
      '{entity}',
    ],
    {
      ...NOOP_LOCK_DEPS,
      now: () => '2026-07-01T12:00:00Z',
      fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON');
      },
      writeSnapshotAtomic: () => {},
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(result.code, 2);
  assert.equal(result.output, '');
  assert.match(result.stderr, /^gh-delta: error \{/);
  assert.match(result.stderr, /invalid snapshot JSON/);
});

test('template format keeps successful repo lines when the first repo fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-multi-'));
  const argv = [
    '--repo',
    'o/a,o/b',
    '--monitor-id',
    'm',
    '--state-dir',
    dir,
    '--entities',
    'pr',
    '--format',
    'template',
    '--template',
    '{repo} {entity} #{number}',
  ];
  const baselineFetch = (repo) => ({
    rows: [{ ...basePr, headSha: repo === 'o/a' ? 'sha-a' : 'sha-b' }],
    rateLimit: RATE_LIMIT,
  });
  const baseline = await runCommand(argv, {
    ...NOOP_LOCK_DEPS,
    now: () => '2026-07-01T12:00:00Z',
    fetchPRs: baselineFetch,
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(baseline.code, 0);
  const tick = await runCommand(argv, {
    ...NOOP_LOCK_DEPS,
    now: () => '2026-07-01T13:00:00Z',
    fetchPRs: (repo) => {
      if (repo === 'o/a') throw new Error('github down');
      return { rows: [{ ...basePr, headSha: 'sha-b2' }], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(tick.code, 1);
  assert.match(tick.output, /o\/b pr #42\n/);
  assert.match(tick.stderr, /gh-delta: error \{/);
  assert.match(tick.stderr, /github down/);
});

test('cursor without set keeps ordinary JSON errors when format is template', async () => {
  const result = await runCommand(['cursor', '--format', 'template'], {
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.match(result.output, /cursor requires the set subcommand/);
  assert.doesNotMatch(result.output, /gh-delta: error/);
});

test('read reports a missing cursor before a bad template', async () => {
  const result = await runCommand(
    ['read', '--format', 'template', '--template', '{summary.typo}'],
    { env: { GH_DELTA_NO_REGISTRY: '1' } },
  );
  assert.equal(result.code, 2);
  assert.match(result.output + result.stderr, /--cursor is required/);
  assert.doesNotMatch(result.output + result.stderr, /summary\.typo|unknown/i);
});

test('a project config template names the config layer in the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-cfg-'));
  writeFileSync(join(dir, '.gh-delta.json'), JSON.stringify({ template: '{id}' }));
  let fetched = false;
  const result = await runCommand(['--repo', 'o/r', '--state-file', join(dir, 'state.json')], {
    cwd: () => dir,
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: null };
    },
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(result.code, 2);
  assert.equal(fetched, false);
  assert.match(result.output + result.stderr, /project|config key/i);
});

test('read does not advance the cursor when a template leaf is an object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-leaf-'));
  const logFile = join(dir, 'log.ndjson');
  writeFileSync(logFile, '');
  const cursor = join(dir, 'cursor.json');
  setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
  const before = readFileSync(cursor);
  const result = await runCommand(
    ['read', '--cursor', cursor, '--advance', '--format', 'template', '--template', '{classes}'],
    {
      env: { GH_DELTA_NO_REGISTRY: '1' },
      readDeltaLog: () => ({
        entries: [{ delta: { entity: 'pr', number: 1, classes: [{ name: 'bug' }] }, seq: 1 }],
        lastSeq: 1,
        firstSeq: 1,
        scannedTo: 1,
      }),
    },
  );
  assert.equal(result.code, 2);
  assert.equal(result.output, '');
  assert.match(result.stderr, /gh-delta: error \{/);
  assert.deepEqual(readFileSync(cursor), before);
});

test('read templates use journal repo and seq without changing public deltas', async () => {
  const stored = { id: 'd1', entity: 'pr', number: 42, classes: ['new'] };
  const d = {
    env: { GH_DELTA_NO_REGISTRY: '1' },
    readCursor: () => ({ logFile: '/tmp/unused.ndjson', seq: 0 }),
    readDeltaLog: () => ({
      entries: [{ repo: 'acme/widgets', seq: 17, delta: stored }],
      lastSeq: 17,
      firstSeq: 1,
      scannedTo: 17,
    }),
  };
  const result = await runCommand(
    [
      'read',
      '--cursor',
      '/tmp/unused.cursor',
      '--format',
      'template',
      '--template',
      '{repo} #{number} @{seq}',
    ],
    d,
  );
  assert.equal(result.code, 10);
  assert.equal(result.output, 'acme/widgets #42 @17\n');
  assert.deepEqual(result.report.deltas, [stored]);
  assert.deepEqual(
    (await runCommand(['read', '--cursor', '/tmp/unused.cursor'], d)).report.deltas,
    [stored],
  );
});

test('template changes terminal output only across detail, full, filtering and baseline flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-equivalence-'));
  try {
    for (const flags of [
      [],
      ['--detail'],
      ['--summary-line'],
      ['--summaries'],
      ['--full'],
      ['--detail', '--full'],
      ['--ignore-classes', 'head-changed'],
    ]) {
      const existing = { pr: { 42: item(openFp) }, issue: {} };
      const rows = [{ ...basePr, headSha: 'sha2' }];
      const outputs = [];
      for (const format of ['json', 'template']) {
        const d = deps([[...rows]], { existing: globalThis.structuredClone(existing) });
        let logged;
        d.appendDeltaLog = (_path, value) => {
          logged = globalThis.structuredClone(value);
          return { appended: value.deltas.length };
        };
        d.fetchEnrichment = () => assert.fail('selecting enrichment fields must not fetch');
        const result = await runCommand(
          [
            '--repo',
            'o/r',
            '--monitor-id',
            'main',
            '--state-file',
            join(dir, 'state'),
            '--log',
            ...flags,
            '--format',
            format,
            ...(format === 'template'
              ? ['--template', '{repo} #{number}: {to.headSha}|{enrichment.body.body}']
              : []),
          ],
          d,
        );
        outputs.push({ result, snapshot: d.stored, logged });
      }
      assert.equal(outputs[0].result.code, outputs[1].result.code);
      assert.deepEqual(outputs[0].result.report, outputs[1].result.report);
      assert.deepEqual(outputs[0].snapshot, outputs[1].snapshot);
      assert.deepEqual(outputs[0].logged, outputs[1].logged);
      assert.equal(
        outputs[1].result.output,
        flags.includes('--ignore-classes') ? '' : 'o/r #42: sha2|\n',
      );
    }
    for (const flags of [[], ['--baseline-emit-state']]) {
      const result = await runCommand(
        [
          '--repo',
          'o/r',
          '--state-file',
          join(dir, 'baseline'),
          '--format',
          'template',
          '--template',
          '{number}',
          ...flags,
        ],
        deps([[basePr]]),
      );
      assert.equal(result.code, flags.length ? 10 : 0);
      assert.equal(result.output, flags.length ? '42\n' : '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('template hash mismatch prevents detector and cursor mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-reject-hash-'));
  try {
    const path = join(dir, 'line');
    writeFileSync(path, '{id}\n');
    const forbidden = () => assert.fail('hash mismatch must fail before effects');
    const d = {
      env: { GH_DELTA_NO_REGISTRY: '1' },
      resolveRepo: forbidden,
      fetchPRs: forbidden,
      acquireLock: forbidden,
      readCursor: forbidden,
      readDeltaLog: forbidden,
      appendDeltaLog: forbidden,
      writeSnapshotAtomic: forbidden,
      registerMonitor: forbidden,
    };
    for (const prefix of [
      [],
      ['--repo', 'o/a,o/b'],
      ['read', '--cursor', join(dir, 'cursor'), '--advance'],
    ]) {
      const result = await runCommand(
        [
          ...prefix,
          '--format',
          'template',
          '--template-file',
          path,
          '--template-sha256',
          'a'.repeat(64),
        ],
        d,
      );
      assert.equal(result.code, 2);
      assert.equal(result.output, '');
      assert.match(result.stderr, /sha256/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('template multi-repo publication validates durable leaves per repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-durable-'));
  try {
    const writes = [];
    const result = await runCommand(
      [
        '--repo',
        'o/a,o/b',
        '--state-dir',
        root,
        '--entities',
        'pr',
        '--baseline-emit-state',
        '--format',
        'template',
        '--template',
        '{repo}: {context.title}',
      ],
      {
        ...NOOP_LOCK_DEPS,
        env: { GH_DELTA_NO_REGISTRY: '1' },
        readSnapshot: () => null,
        fetchPRs: (repo) => ({
          rows: [{ ...basePr, title: repo === 'o/a' ? 'accepted' : { invalid: true } }],
          rateLimit: RATE_LIMIT,
        }),
        writeSnapshotAtomic: (_path, snapshot) => writes.push(snapshot.meta.repo),
      },
    );
    assert.equal(result.code, 2);
    assert.equal(result.output, 'o/a: accepted\n');
    assert.deepEqual(writes, ['o/a']);
    assert.match(result.stderr, /primitive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid transient template data preserves other repository lines after publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-transient-'));
  try {
    const published = [];
    const result = await runCommand(
      [
        '--repo',
        'o/a,o/b',
        '--state-dir',
        root,
        '--entities',
        'pr',
        '--baseline-emit-state',
        '--enrich',
        'body',
        '--format',
        'template',
        '--template',
        '{repo}: {enrichment.body.body}',
      ],
      {
        ...NOOP_LOCK_DEPS,
        env: { GH_DELTA_NO_REGISTRY: '1' },
        readSnapshot: () => null,
        fetchPRs: (repo) => ({ rows: [{ ...basePr, id: repo }], rateLimit: RATE_LIMIT }),
        writeSnapshotAtomic: (_path, snapshot) => published.push(snapshot.meta.repo),
        fetchEnrichment: (_kind, ids) => ({
          rows: ids.map((id) => ({
            id,
            body: id === 'o/a' ? 'accepted' : { invalid: true },
            mentions: [],
          })),
          rateLimit: RATE_LIMIT,
        }),
      },
    );
    assert.equal(result.code, 2);
    assert.equal(result.output, 'o/a: accepted\n');
    assert.deepEqual(published, ['o/a', 'o/b']);
    assert.match(result.stderr, /primitive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('multi-repo template uses one accepted file read even after replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-one-read-'));
  try {
    const path = join(root, 'line.txt');
    const raw = '{repo} #{number}\n';
    writeFileSync(path, raw);
    const digest = createHash('sha256').update(raw).digest('hex');
    let reads = 0;
    const result = await runCommand(
      [
        '--repo',
        'o/a,o/b',
        '--state-dir',
        root,
        '--entities',
        'pr',
        '--baseline-emit-state',
        '--format',
        'template',
        '--template-file',
        path,
        '--template-sha256',
        digest,
      ],
      {
        ...NOOP_LOCK_DEPS,
        env: { GH_DELTA_NO_REGISTRY: '1' },
        readSnapshot: () => null,
        fetchPRs: () => ({ rows: [basePr], rateLimit: RATE_LIMIT }),
        writeSnapshotAtomic: () => {},
        readFileSync: (name, encoding) => {
          if (name !== path) return readFileSync(name, encoding);
          reads++;
          const accepted = readFileSync(name);
          writeFileSync(name, '{summary.typo}');
          return accepted;
        },
      },
    );
    assert.equal(result.code, 10);
    assert.equal(result.output, 'o/a #42\no/b #42\n');
    assert.equal(reads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transient body enrichment renders escaped text and stays absent on durable replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-template-enrichment-replay-'));
  try {
    const state = join(root, 'state');
    const d = deps([[basePr]], { existing: { pr: {}, issue: {} } });
    d.fetchEnrichment = () => ({
      rows: [{ id: 'PR_42', body: 'line\n{number} @a @b' }],
      rateLimit: RATE_LIMIT,
    });
    d.fetchPRs = () => ({ rows: [{ ...basePr, id: 'PR_42' }], rateLimit: RATE_LIMIT });
    const produced = await runCommand(
      [
        '--repo',
        'o/r',
        '--state-file',
        state,
        '--log',
        '--enrich',
        'body',
        '--format',
        'template',
        '--template',
        '{enrichment.body.body}|{enrichment.body.mentions}',
      ],
      d,
    );
    assert.equal(produced.code, 10);
    assert.equal(produced.output, 'line\\n{number} @a @b|a,b\n');
    const cursor = join(root, 'cursor');
    setCursorAtomic(cursor, {
      cursorVersion: 1,
      logFile: produced.report.results[0].logFile,
      seq: 0,
    });
    const replay = await runCommand([
      'read',
      '--cursor',
      cursor,
      '--format',
      'template',
      '--template',
      '{enrichment.body.body}|{enrichment.body.mentions}',
    ]);
    assert.equal(replay.code, 10);
    assert.equal(replay.output, '|\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('watch sync manifests keep strict batching, omit-end output, labels, and terminal cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-strict-output-'));
  try {
    const watch = join(dir, 'watch');
    const desired = Array.from(
      { length: 11 },
      (_, i) => `pr:${i + 1} until=merged repo=o/r thread=t-${i + 1}`,
    ).join('\n');
    const synced = await runCommand(['watch', 'sync', '--from', '-', '--watch-dir', watch], {
      stdin: `${desired}\nend 11\n`,
    });
    assert.equal(synced.code, 0);
    const d = deps([[]]);
    const batches = [];
    let merged = false;
    d.fetchPRs = d.fetchIssues = () => assert.fail('strict manifest must use targeted fetches');
    d.fetchPRsByNumber = (_repo, numbers) => {
      batches.push([...numbers]);
      return {
        rows: numbers.map((number) => ({
          ...basePr,
          number,
          state: merged && number === 11 ? 'merged' : 'open',
        })),
        rateLimit: RATE_LIMIT,
      };
    };
    const args = [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'pr',
      '--format',
      'ndjson',
      '--omit-end',
    ];
    const baseline = await runCommand(args, d);
    assert.equal(baseline.code, 0);
    assert.equal(baseline.output, '');
    assert.equal(baseline.stderr, '');
    assert.deepEqual(batches, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
    assert.equal(d.writePath, `${join(dir, 'state.json')}.watch.json`);
    merged = true;
    const tick = await runCommand(args, d);
    assert.equal(tick.code, 10);
    const records = tick.output.trimEnd().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'delta');
    assert.equal(records[0].number, 11);
    assert.deepEqual(records[0].watch.labels, { thread: 't-11' });
    assert.equal(tick.stderr, '');
    assert.equal(readWatch(watch).length, 10);
    assert.equal(
      readWatch(watch).some((entry) => entry.number === 11),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
