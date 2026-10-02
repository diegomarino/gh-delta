// CLI contract tests: economical watch selection, --watch-strict, and wait heartbeats.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basePr, item, RATE_LIMIT, deps, strictPrDir } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { addWatch } from '../lib/watch.mjs';

test('eligible PR-only watch uses the economical fetch and separate explicit state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-economical-watch-'));
  for (const number of [3, 9]) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  const d = deps([[]]);
  let targeted;
  d.fetchPRsByNumber = (_repo, numbers, options) => {
    targeted = { numbers, options };
    return { rows: numbers.map((number) => ({ ...basePr, number })), rateLimit: RATE_LIMIT };
  };
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run for an eligible watch');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/economical.json',
      '--watch-dir',
      dir,
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(targeted.numbers, [3, 9]);
  assert.equal(targeted.options.onProgress instanceof Function, true);
  assert.equal(result.report.results[0].stateFile, '/tmp/economical.json.watch.json');
  assert.equal(d.readPath, '/tmp/economical.json.watch.json');
  assert.equal(d.writePath, '/tmp/economical.json.watch.json');
  assert.deepEqual(Object.keys(d.stored.pr), ['3', '9']);
});

test('empty eligible watch makes no GitHub calls and snapshots an empty PR universe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-empty-economical-watch-'));
  const d = deps([[]]);
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchIssues = () => {
    throw new Error('issue fetch must not run');
  };
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run for empty watch');
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/empty-economical.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.results[0].stateFile, '/tmp/empty-economical.json.watch.json');
  assert.deepEqual(d.stored.pr, {});
  assert.deepEqual(d.stored.issue, {});
});

test('ineligible watch lists retain broad fetch and ordinary state history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-broad-watch-'));
  for (let number = 1; number <= 11; number++) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  const d = deps([[basePr]]);
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run for 11 watches');
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/broad-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.results[0].stateFile, '/tmp/broad-watch.json');
  assert.equal(d.readPath, '/tmp/broad-watch.json');
});

test('watch-strict at 11 PRs uses the economical snapshot and rejects issue entries before fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-11-'));
  for (let number = 1; number <= 11; number++) {
    writeFileSync(
      join(dir, `pr-${number}.json`),
      JSON.stringify({ entity: 'pr', number, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
    );
  }
  const d = deps([[]]);
  const numbers = [];
  let broad = false;
  d.fetchPRsByNumber = (_repo, batch) => {
    numbers.push([...batch]);
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: RATE_LIMIT,
    };
  };
  d.fetchPRs = () => {
    broad = true;
    throw new Error('broad fetch must not run');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(broad, false);
  assert.deepEqual(numbers, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
  assert.equal(result.report.results[0].stateFile, `${join(dir, 'state.json')}.watch.json`);
  writeFileSync(
    join(dir, 'issue-4.json'),
    JSON.stringify({
      entity: 'issue',
      number: 4,
      until: 'closed',
      addedAt: '2026-07-01T00:00:00Z',
    }),
  );
  let called = false;
  d.fetchPRsByNumber = () => {
    called = true;
    return { rows: [], rateLimit: null };
  };
  d.fetchPRs = () => {
    called = true;
    throw new Error('broad fetch must not run');
  };
  const rejected = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(rejected.code, 2);
  assert.equal(called, false);

  const noDir = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(noDir.code, 2);
  assert.equal(called, false);

  const issuesOnly = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'issue',
    ],
    d,
  );
  assert.equal(issuesOnly.code, 2);
  assert.match(
    issuesOnly.report.results?.[0]?.error?.message ?? issuesOnly.report.error,
    /--watch-strict cannot include pr watch entries/,
  );
  assert.equal(called, false);

  const numbered = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--number',
      '1',
    ],
    d,
  );
  assert.equal(numbered.code, 2);
  assert.equal(called, false);

  let waitFetched = false;
  const waited = await runCommand(
    [
      'wait',
      '--from-log',
      '--watch-strict',
      '--cursor',
      join(dir, 'cursor.json'),
      '--timeout',
      '1s',
      '--until',
      'ci-changed',
    ],
    {
      ...d,
      env: { GH_DELTA_NO_REGISTRY: '1' },
      fetchPRs: () => {
        waitFetched = true;
        throw new Error('wait must not fetch');
      },
      fetchPRsByNumber: () => {
        waitFetched = true;
        throw new Error('wait must not fetch');
      },
    },
  );
  assert.equal(waited.code, 2);
  assert.match(waited.report.error, /--watch-strict cannot be used with --from-log/);
  assert.equal(waitFetched, false);
});

test('strict mode publishes nothing when the second batch fails', () => {
  const dir = strictPrDir('gd-strict-batch-fail-', 11);
  const d = deps([[]]);
  let calls = 0;
  let logged = false;
  d.appendDeltaLog = () => {
    logged = true;
    return { fromSeq: 1, toSeq: 1, appended: 1 };
  };
  d.fetchPRsByNumber = (_repo, batch) => {
    calls++;
    if (calls === 2) throw new Error('batch failed');
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: { cost: 3, remaining: 4997, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--log',
    ],
    d,
  );
  assert.equal(result.code, 1);
  assert.equal(calls, 2);
  assert.equal(d.writes, 0);
  assert.equal(logged, false);
  assert.deepEqual(result.report.results[0].rateLimit, {
    cost: 3,
    remaining: 4997,
    resetAt: '2026-07-01T13:00:00Z',
  });
});

test('strict floor refuses before the first batch', () => {
  const dir = strictPrDir('gd-strict-floor-deny-', 11);
  const refused = deps([[]]);
  let calls = 0;
  refused.fetchRateLimit = () => ({ remaining: 101, resetAt: '2026-07-01T13:00:00Z' });
  refused.fetchPRsByNumber = () => {
    calls++;
    throw new Error('must not fetch');
  };
  const denied = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'a.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--rate-limit-floor',
      '100',
    ],
    refused,
  );
  assert.equal(denied.code, 1);
  assert.equal(calls, 0);
  assert.match(denied.report.results[0].error.message, /101/);
  assert.match(denied.report.results[0].error.message, /100/);
  assert.match(denied.report.results[0].error.message, /2/);
  assert.equal(denied.report.results[0].error.resetAt, '2026-07-01T13:00:00Z');
  assert.equal(denied.report.results[0].rateLimit, null);
});

test('strict floor refuses the second batch after an expensive first batch and publishes nothing', () => {
  const dir = strictPrDir('gd-strict-floor-mid-', 11);
  const d = deps([[]]);
  let calls = 0;
  d.fetchRateLimit = () => ({ remaining: 102, resetAt: '2026-07-01T13:00:00Z' });
  d.fetchPRsByNumber = (_repo, batch) => {
    calls++;
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: { cost: 2, remaining: 100, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--rate-limit-floor',
      '100',
    ],
    d,
  );
  assert.equal(result.code, 1);
  assert.equal(calls, 1);
  assert.equal(d.writes, 0);
  assert.deepEqual(result.report.results[0].rateLimit, {
    cost: 2,
    remaining: 100,
    resetAt: '2026-07-01T13:00:00Z',
  });
  assert.equal(result.report.results[0].error.kind, 'rate-limit');
  assert.equal(result.report.results[0].error.cost, 2);
  assert.equal(result.report.results[0].error.remaining, 100);
});

test('strict floor admits the last batch and publishes when that batch finishes below the floor', () => {
  const dir = strictPrDir('gd-strict-floor-last-', 11);
  const allowed = deps([[]]);
  let calls = 0;
  allowed.fetchRateLimit = () => ({ remaining: 102, resetAt: '2026-07-01T13:00:00Z' });
  allowed.fetchPRsByNumber = (_repo, batch) => {
    calls++;
    const remaining = calls === 1 ? 101 : 40;
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: { cost: 1, remaining, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const ok = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'b.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--rate-limit-floor',
      '100',
    ],
    allowed,
  );
  assert.equal(ok.code, 0);
  assert.equal(calls, 2);
  assert.equal(ok.report.results[0].rateLimit.remaining, 40);
});

test('empty strict membership skips the rate-limit preflight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-empty-'));
  const d = deps([[]]);
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchIssues = () => {
    throw new Error('issue fetch must not run');
  };
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run');
  };
  d.fetchRateLimit = () => {
    throw new Error('quota preflight must not run');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--rate-limit-floor',
      '100',
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.results[0].stateFile, `${join(dir, 'state.json')}.watch.json`);
  assert.deepEqual(d.stored.pr, {});
});

test('strict null alias for a still-watched PR enters the normal missing lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-null-'));
  writeFileSync(
    join(dir, 'pr-3.json'),
    JSON.stringify({ entity: 'pr', number: 3, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([], {
    existing: { pr: { 3: item(prFingerprint({ ...basePr, number: 3 })) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [], rateLimit: RATE_LIMIT });
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.classes),
    [['missing']],
  );
});

test('strict mode publishes nothing when watch membership changes before publication', () => {
  const dir = strictPrDir('gd-strict-changed-', 1);
  const d = deps([[]]);
  d.fetchPRsByNumber = (_repo, batch) => {
    writeFileSync(
      join(dir, 'pr-12.json'),
      JSON.stringify({
        entity: 'pr',
        number: 12,
        until: 'merged',
        addedAt: '2026-07-01T00:00:00Z',
      }),
    );
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(result.code, 1);
  assert.match(result.report.results[0].error.message, /watch membership changed/);
  assert.equal(d.writes, 0);
});

test('status --watch-strict reads the economical snapshot at size 11 and leaves the broad path without the flag', () => {
  const dir = strictPrDir('gd-strict-status-', 11);
  const state = join(dir, 'state.json');
  const d = deps([[]]);
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchPRsByNumber = (_repo, batch) => ({
    rows: batch.map((number) => ({ ...basePr, number })),
    rateLimit: RATE_LIMIT,
  });
  const tick = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      state,
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(tick.code, 0);
  assert.equal(tick.report.results[0].stateFile, `${state}.watch.json`);
  let statusFetches = 0;
  d.fetchPRs = () => {
    statusFetches++;
    throw new Error('status must not fetch');
  };
  d.fetchPRsByNumber = () => {
    statusFetches++;
    throw new Error('status must not fetch');
  };
  const strictStatus = run(
    [
      'status',
      '--repo',
      'o/r',
      '--state-file',
      state,
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(strictStatus.code, 0);
  assert.equal(statusFetches, 0);
  assert.equal(d.readPath, `${state}.watch.json`);
  const broadStatus = run(
    ['status', '--repo', 'o/r', '--state-file', state, '--watch-dir', dir, '--entities', 'pr'],
    d,
  );
  assert.equal(broadStatus.code, 0);
  assert.equal(statusFetches, 0);
  assert.equal(d.readPath, state);
});

test('status --watch-strict rejects issue entries and illegal selections before reading a snapshot', () => {
  const dir = strictPrDir('gd-strict-status-reject-', 11);
  writeFileSync(
    join(dir, 'issue-4.json'),
    JSON.stringify({
      entity: 'issue',
      number: 4,
      until: 'closed',
      addedAt: '2026-07-01T00:00:00Z',
    }),
  );
  const d = deps([[]]);
  let fetched = 0;
  d.fetchPRs = () => {
    fetched++;
    throw new Error('status must not fetch');
  };
  d.fetchPRsByNumber = () => {
    fetched++;
    throw new Error('status must not fetch');
  };
  d.readSnapshot = () => {
    throw new Error('status must not read a snapshot');
  };
  const issueEntry = run(
    ['status', '--repo', 'o/r', '--watch-dir', dir, '--watch-strict', '--entities', 'pr'],
    d,
  );
  assert.equal(issueEntry.code, 2);
  assert.match(issueEntry.report.error, /--watch-strict cannot include issue watch entries/);
  const missingDir = run(['status', '--repo', 'o/r', '--watch-strict', '--entities', 'pr'], d);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.report.error, /--watch-strict requires --watch-dir/);
  const issuesOnly = run(
    ['status', '--repo', 'o/r', '--watch-dir', dir, '--watch-strict', '--entities', 'issue'],
    d,
  );
  assert.equal(issuesOnly.code, 2);
  assert.match(issuesOnly.report.error, /--watch-strict cannot include pr watch entries/);
  assert.equal(fetched, 0);
});

test('strict config errors do not resolve a repository', () => {
  const dir = strictPrDir('gd-strict-preresolve-', 1);
  const d = deps([[]]);
  d.resolveRepo = () => {
    throw new Error('must not resolve a repository');
  };
  const missingDir = run(
    ['--watch-strict', '--entities', 'pr', '--state-file', join(dir, 's.json')],
    d,
  );
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.report.error, /--watch-strict requires --watch-dir/);
  const issuesOnly = run(
    [
      '--watch-strict',
      '--entities',
      'issue',
      '--watch-dir',
      dir,
      '--state-file',
      join(dir, 's.json'),
    ],
    d,
  );
  assert.equal(issuesOnly.code, 2);
  assert.match(issuesOnly.report.error, /--watch-strict cannot include pr watch entries/);
  const numbered = run(
    ['--watch-strict', '--number', '1', '--entities', 'pr', '--state-file', join(dir, 's.json')],
    d,
  );
  assert.equal(numbered.code, 2);
});

test('empty strict membership resolves an omitted repo locally and skips remote discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-empty-repo-'));
  const d = deps([[]]);
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run');
  };
  d.fetchRateLimit = () => {
    throw new Error('quota preflight must not run');
  };
  let sawLocalOnly = false;
  d.resolveRepo = (options) => {
    sawLocalOnly = options?.localOnly === true;
    return { status: 'found', repo: 'o/r', source: 'git-remote', warnings: [] };
  };
  const found = run(
    [
      '--state-file',
      join(dir, 'state.json'),
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
      '--rate-limit-floor',
      '100',
    ],
    d,
  );
  assert.equal(found.code, 0);
  assert.equal(sawLocalOnly, true);
  assert.equal(found.report.results[0].stateFile, `${join(dir, 'state.json')}.watch.json`);
  d.resolveRepo = (options) => {
    assert.equal(options?.localOnly, true);
    return { status: 'declined' };
  };
  const declined = run(
    ['--watch-dir', dir, '--watch-strict', '--entities', 'pr', '--state-file', join(dir, 'b.json')],
    d,
  );
  assert.equal(declined.code, 2);
  assert.match(declined.report.error, /local git remotes/);
});

test('GH_DELTA_WATCH_STRICT and project config select the economical snapshot at size 11', () => {
  const dir = strictPrDir('gd-strict-config-', 11);
  const isolated = {
    env: { GH_DELTA_NO_REGISTRY: '1', GH_DELTA_WATCH_STRICT: '1' },
    homedir: () => dir,
    configReadFileSync: () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  };
  const fromEnv = deps([[]]);
  let broad = false;
  fromEnv.fetchPRs = () => {
    broad = true;
    throw new Error('broad fetch must not run');
  };
  fromEnv.fetchPRsByNumber = (_repo, batch) => ({
    rows: batch.map((number) => ({ ...basePr, number })),
    rateLimit: RATE_LIMIT,
  });
  const envResult = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'env.json'),
      '--watch-dir',
      dir,
      '--entities',
      'pr',
    ],
    { ...fromEnv, ...isolated },
  );
  assert.equal(envResult.code, 0);
  assert.equal(broad, false);
  assert.equal(envResult.report.results[0].stateFile, `${join(dir, 'env.json')}.watch.json`);

  const fromConfig = deps([[]]);
  fromConfig.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  fromConfig.fetchPRsByNumber = (_repo, batch) => ({
    rows: batch.map((number) => ({ ...basePr, number })),
    rateLimit: RATE_LIMIT,
  });
  const configResult = run(
    [
      '--repo',
      'o/r',
      '--state-file',
      join(dir, 'cfg.json'),
      '--watch-dir',
      dir,
      '--entities',
      'pr',
    ],
    {
      ...fromConfig,
      env: { GH_DELTA_NO_REGISTRY: '1' },
      homedir: () => dir,
      configReadFileSync: (path) => {
        if (String(path).endsWith('.gh-delta.json')) return '{"watch-strict":true}';
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    },
  );
  assert.equal(configResult.code, 0);
  assert.equal(configResult.report.results[0].stateFile, `${join(dir, 'cfg.json')}.watch.json`);
});

test('status --refresh --watch-strict forwards the flag into the detector tick', () => {
  const dir = strictPrDir('gd-strict-refresh-', 11);
  const state = join(dir, 'state.json');
  const d = deps([[]]);
  const batches = [];
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.fetchPRsByNumber = (_repo, batch) => {
    batches.push([...batch]);
    return {
      rows: batch.map((number) => ({ ...basePr, number })),
      rateLimit: RATE_LIMIT,
    };
  };
  const result = run(
    [
      'status',
      '--refresh',
      '--repo',
      'o/r',
      '--state-file',
      state,
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(batches, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
  assert.equal(d.readPath, `${state}.watch.json`);
});

test('strict multi-repo preflight rejects a later issue entry before any repository fetches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-multi-issue-'));
  addWatch(dir, 'pr:1', 'merged', { now: () => '2026-07-01T00:00:00Z', repo: 'a/one' });
  addWatch(dir, 'issue:4', 'closed', { now: () => '2026-07-01T00:00:00Z', repo: 'b/two' });
  let fetched = 0;
  const result = run(
    [
      '--repo',
      'a/one,b/two',
      '--state-dir',
      dir,
      '--watch-dir',
      dir,
      '--watch-strict',
      '--entities',
      'pr',
    ],
    {
      ...deps([[]]),
      env: { GH_DELTA_NO_REGISTRY: '1' },
      fetchPRs: () => {
        fetched++;
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchPRsByNumber: () => {
        fetched++;
        return { rows: [], rateLimit: RATE_LIMIT };
      },
    },
  );
  assert.equal(result.code, 2);
  assert.match(result.report.error, /issue watch entries/);
  assert.equal(fetched, 0);
});

test('removing a watch projects old economical state without a missing delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-project-watch-'));
  writeFileSync(
    join(dir, 'pr-3.json'),
    JSON.stringify({ entity: 'pr', number: 3, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([], {
    existing: {
      pr: {
        3: item(prFingerprint({ ...basePr, number: 3 })),
        9: item(prFingerprint({ ...basePr, number: 9 })),
      },
      issue: {},
    },
  });
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr, number: 3 }], rateLimit: RATE_LIMIT });
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/project-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.deltas, []);
  assert.deepEqual(Object.keys(d.stored.pr), ['3']);
});

test('a null alias for a still-watched PR enters the normal missing lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-null-watch-'));
  writeFileSync(
    join(dir, 'pr-3.json'),
    JSON.stringify({ entity: 'pr', number: 3, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([], {
    existing: { pr: { 3: item(prFingerprint({ ...basePr, number: 3 })) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [], rateLimit: RATE_LIMIT });
  const result = run(
    ['--repo', 'o/r', '--state-file', '/tmp/null-watch.json', '--watch-dir', dir],
    d,
  );
  assert.equal(result.code, 10);
  assert.deepEqual(
    result.report.deltas.map((delta) => delta.classes),
    [['missing']],
  );
});

test('economical watch logs derive from the selected state identity for explicit and derived paths', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-log-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const runEconomical = (stateArgs) => {
    const d = deps([], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
    d.fetchPRsByNumber = () => ({
      rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
      rateLimit: RATE_LIMIT,
    });
    let appended;
    d.appendDeltaLog = (file, record) => {
      appended = file;
      return { fromSeq: 1, toSeq: record.deltas.length, appended: record.deltas.length };
    };
    d.removeWatchUnchanged = () => false;
    const result = run(['--repo', 'o/r', '--watch-dir', watch, '--log', ...stateArgs], d);
    return { result, appended };
  };
  const explicit = runEconomical(['--state-file', '/tmp/economical-log.json']);
  assert.equal(explicit.result.report.results[0].stateFile, '/tmp/economical-log.json.watch.json');
  assert.equal(
    explicit.result.report.results[0].logFile,
    '/tmp/economical-log.json.watch.json.deltalog.ndjson',
  );
  assert.equal(explicit.appended, explicit.result.report.results[0].logFile);

  const derived = runEconomical(['--state-dir', '/tmp/economical-log-state']);
  assert.match(derived.result.report.results[0].stateFile, /__watch-pr\.json$/);
  assert.equal(
    derived.result.report.results[0].logFile,
    `${derived.result.report.results[0].stateFile}.deltalog.ndjson`,
  );
  assert.equal(derived.appended, derived.result.report.results[0].logFile);
});

test('--entities issue makes a PR-only watch list retain normal full-fetch state', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-issue-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([[]]);
  d.fetchPRsByNumber = () => {
    throw new Error('targeted fetch must not run without PR entity selection');
  };
  const result = run(
    [
      '--repo',
      'o/r',
      '--entities',
      'issue',
      '--state-file',
      '/tmp/issue-watch.json',
      '--watch-dir',
      watch,
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.equal(result.report.results[0].stateFile, '/tmp/issue-watch.json');
  assert.deepEqual(d.stored.pr, {});
  assert.deepEqual(d.stored.issue, {});
});

test('economical run registers PR-only watch identity and scope', () => {
  const watch = mkdtempSync(join(tmpdir(), 'gd-economical-reg-watch-'));
  writeFileSync(
    join(watch, 'pr-42.json'),
    JSON.stringify({ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00Z' }),
  );
  const d = deps([[]]);
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  const registered = [];
  d.registerMonitor = (entry) => registered.push(entry);
  d.env = { GH_DELTA_REGISTRY_DIR: '/tmp/economical-registry' };
  run(['--repo', 'o/r', '--state-file', '/tmp/economical-reg.json', '--watch-dir', watch], d);
  assert.deepEqual(registered[0].entities, ['pr']);
  assert.equal(registered[0].scope, 'watch-pr');
  assert.equal(registered[0].stateFile, '/tmp/economical-reg.json.watch.json');
});

test('strict unscoped issues fail before repository discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-issue-discovery-'));
  try {
    writeFileSync(
      join(dir, 'issue-1.json'),
      JSON.stringify({
        entity: 'issue',
        number: 1,
        until: 'closed',
        addedAt: '2026-07-01T00:00:00Z',
      }),
    );
    const d = deps([[]]);
    let discoveries = 0;
    d.resolveRepo = () => {
      discoveries++;
      return { status: 'failed', reason: 'offline' };
    };
    const result = run(['--watch-dir', dir, '--watch-strict', '--entities', 'pr'], d);
    assert.equal(result.code, 2);
    assert.match(result.report.error, /--watch-strict cannot include issue watch entries/);
    assert.equal(discoveries, 0);
    assert.equal(d.writes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const strict of [false, true]) {
  for (const explicitState of [false, true]) {
    for (const override of [false, true]) {
      test(`watch wait heartbeat follows snapshot: strict=${strict}, explicitState=${explicitState}, override=${override}`, async () => {
        const dir = strictPrDir('gd-watch-heartbeat-', strict ? 11 : 1);
        try {
          const state = join(dir, 'state.json');
          const heartbeat = join(dir, 'custom.hb');
          const d = deps([[]]);
          const touched = [];
          let clock = 0;
          d.fetchPRsByNumber = () => ({ rows: [], rateLimit: RATE_LIMIT });
          const result = await runCommand(
            [
              'wait',
              '--repo',
              'o/r',
              '--monitor-id',
              'heartbeat',
              explicitState ? '--state-file' : '--state-dir',
              state,
              '--watch-dir',
              dir,
              '--entities',
              'pr',
              ...(strict ? ['--watch-strict'] : []),
              ...(override ? ['--heartbeat-file', heartbeat] : []),
              '--until',
              'merged',
              '--timeout',
              '1s',
              '--interval',
              '1s',
            ],
            {
              ...d,
              clock: () => clock,
              sleep: async (ms) => {
                clock += ms;
              },
              handleSignals: false,
              touchHeartbeat: (path) => touched.push(path),
            },
          );
          assert.equal(result.code, 0);
          assert.ok(d.writePath.endsWith(explicitState ? '.watch.json' : '__watch-pr.json'));
          assert.ok(touched.length > 0);
          assert.deepEqual([...new Set(touched)], [override ? heartbeat : `${d.writePath}.hb`]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}

test('invalid strict waits fail before heartbeat or detector state mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-wait-validation-'));
  try {
    const watch = join(dir, 'watch');
    mkdirSync(watch);
    const cases = [
      { args: [], error: /requires --watch-dir/ },
      {
        args: ['--watch-dir', watch, '--entities', 'issue'],
        entry: { entity: 'pr', number: 2, until: 'merged' },
        error: /cannot include pr watch entries/,
      },
      { args: ['--watch-dir', watch, '--number', '1'], error: /mutually exclusive/ },
      {
        args: ['--watch-dir', watch],
        entry: { entity: 'issue', number: 1, until: 'closed' },
        error: /cannot include issue watch entries/,
      },
      {
        args: ['--watch-dir', watch, '--repo', 'o/r,a/b'],
        entry: { entity: 'issue', number: 1, until: 'closed', repo: 'a/b' },
        error: /cannot include issue watch entries/,
      },
      { args: ['--watch-dir', watch], malformed: true, error: /invalid watch entry/ },
    ];
    for (const scenario of cases) {
      if (scenario.entry) {
        const entry = { ...scenario.entry, addedAt: '2026-07-01T00:00:00Z' };
        const { watchFilename } = await import('../lib/watch.mjs');
        writeFileSync(join(watch, watchFilename(entry)), JSON.stringify(entry));
      }
      if (scenario.malformed) writeFileSync(join(watch, 'pr-1.json'), 'invalid');
      for (const explicitHeartbeat of [false, true]) {
        const forbidden = () => assert.fail('invalid wait must not mutate state or fetch');
        const result = await runCommand(
          [
            'wait',
            '--repo',
            'o/r',
            '--watch-strict',
            '--entities',
            'pr',
            '--state-dir',
            join(dir, 'state'),
            '--until',
            'merged',
            '--timeout',
            '1s',
            ...(explicitHeartbeat ? ['--heartbeat-file', join(dir, 'worker.hb')] : []),
            ...scenario.args,
          ],
          {
            ...deps([[]]),
            handleSignals: false,
            touchHeartbeat: forbidden,
            acquireLock: forbidden,
            writeSnapshotAtomic: forbidden,
            fetchPRs: forbidden,
            fetchPRsByNumber: forbidden,
            fetchIssues: forbidden,
            appendDeltaLog: forbidden,
          },
        );
        assert.equal(result.code, 2);
        assert.match(result.report.error, scenario.error);
      }
      for (const entry of readdirSync(watch)) rmSync(join(watch, entry));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generation change before publication writes no snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-sync-gen-abort-'));
  writeFileSync(join(dir, 'desired.txt'), 'pr:42 until=merged\nend 1\n');
  run(['watch', 'sync', '--from', join(dir, 'desired.txt'), '--watch-dir', join(dir, 'watch')], {
    now: () => '2026-09-30T10:00:00.000Z',
  });
  let calls = 0;
  const d = deps([[]]);
  d.fetchPRsByNumber = () => ({ rows: [{ ...basePr }], rateLimit: RATE_LIMIT });
  d.fetchPRs = () => {
    throw new Error('broad fetch must not run');
  };
  d.readWatchGeneration = () => {
    calls += 1;
    return {
      entries: [{ entity: 'pr', number: 42, until: 'merged', addedAt: '2026-09-30T10:00:00.000Z' }],
      generation: calls === 1 ? 'g1' : 'g2',
    };
  };
  const result = run(
    ['--repo', 'o/r', '--state-file', join(dir, 'state.json'), '--watch-dir', join(dir, 'watch')],
    d,
  );
  assert.equal(result.code, 1);
  assert.equal(d.writes, 0);
  assert.equal(calls, 2);
});
