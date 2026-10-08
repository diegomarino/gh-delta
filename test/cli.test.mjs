// CLI contract tests: detector exits, snapshots, rate-limit floor, and timeouts.
// Neighboring CLI behavior stays in focused siblings: test/cli-*.test.mjs.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basePr,
  item,
  openFp,
  NOOP_LOCK_DEPS,
  RATE_LIMIT,
  DEFAULT_OLD_META,
  deps,
} from './helpers/cli-fixtures.mjs';
import { run } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';

test('first run returns code 0 (baseline) and writes the snapshot', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.results[0].baseline, true);
  assert.equal(report.monitorId, 'main');
  assert.deepEqual(report.entities, ['pr', 'issue']);
  assert.equal(d.writes, 1);
});

test('recent closed items stay quiet after startup but later updates and reopening are detected', () => {
  const d = deps([]);
  let at = '2026-07-01T12:00:00.000Z';
  let pr = { ...basePr, state: 'closed', updatedAt: '2026-07-01T11:59:00.000Z' };
  let issue = { number: 43, state: 'closed', updatedAt: pr.updatedAt, conversationComments: 0 };
  const fetch = (row, cutoff) => ({
    rows:
      row.state === 'open' || (cutoff && Date.parse(row.updatedAt) >= Date.parse(cutoff))
        ? [row]
        : [],
    rateLimit: RATE_LIMIT,
  });
  d.fetchPRs = (_repo, opts) => fetch(pr, opts.horizonCutoff);
  d.fetchIssues = (_repo, opts) => fetch(issue, opts.horizonCutoff);
  d.now = () => at;
  const tick = () =>
    run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(tick().code, 0);
  at = '2026-07-01T12:01:00.000Z';
  const unchanged = tick();
  assert.equal(unchanged.code, 0);
  assert.deepEqual(unchanged.report.deltas, []);

  pr = { ...pr, updatedAt: '2026-07-01T12:01:30.000Z', conversationComments: 1 };
  issue = { ...issue, updatedAt: pr.updatedAt, conversationComments: 1 };
  at = '2026-07-01T12:02:00.000Z';
  const updated = tick();
  assert.equal(updated.code, 10);
  assert.deepEqual(
    updated.report.deltas.map((delta) => delta.classes),
    [['first-seen'], ['first-seen']],
  );
  at = '2026-07-01T12:03:00.000Z';
  assert.equal(tick().code, 0);

  pr = { ...pr, state: 'open', updatedAt: '2026-07-01T12:03:30.000Z' };
  at = '2026-07-01T12:04:00.000Z';
  const reopened = tick();
  assert.equal(reopened.code, 10);
  assert.ok(reopened.report.deltas.some((delta) => delta.classes.includes('reopened')));
});

for (const offsetMs of [-30_000, 30_000]) {
  test(`baseline calibrates GitHub offset ${offsetMs}ms and preserves it across ticks`, () => {
    const d = deps([]);
    let at = '2026-07-01T12:00:00.000Z';
    const serverStart = Date.parse(at) + offsetMs;
    const iso = (time) => new Date(time).toISOString();
    let pr = { ...basePr, updatedAt: iso(serverStart - 60_000) };
    let issue = { number: 7, state: 'open', updatedAt: pr.updatedAt, conversationComments: 0 };
    const historical = { number: 43, state: 'closed', updatedAt: iso(serverStart - 10_000) };
    let calibrations = 0;
    const fetch = (rows, opts) => {
      if (opts.onServerTime) {
        calibrations++;
        opts.onServerTime(iso(Date.parse(at) + offsetMs));
      }
      return {
        rows: rows.filter(
          (row) =>
            row.state === 'open' || (opts.horizonCutoff && row.updatedAt >= opts.horizonCutoff),
        ),
        rateLimit: RATE_LIMIT,
      };
    };
    d.fetchPRs = (_repo, opts) => fetch([pr], opts);
    d.fetchIssues = (_repo, opts) => fetch([issue, historical], opts);
    d.now = () => at;
    const tick = () =>
      run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
    assert.equal(tick().code, 0);
    assert.equal(d.stored.meta.horizon, iso(serverStart));
    assert.equal(d.stored.meta.updatedAt, at);
    at = '2026-07-01T12:01:00.000Z';
    assert.equal(tick().code, 0);
    assert.equal(d.stored.issue['43'], undefined);
    assert.equal(d.stored.meta.horizon, iso(Date.parse(at) + offsetMs));

    pr = { ...pr, state: 'closed', updatedAt: iso(serverStart + 70_000) };
    issue = { ...issue, state: 'closed', updatedAt: pr.updatedAt };
    at = '2026-07-01T12:02:00.000Z';
    const closed = tick();
    assert.equal(closed.code, 10);
    assert.deepEqual(
      closed.report.deltas.map((delta) => delta.classes),
      [['closed'], ['closed']],
    );
    at = '2026-07-01T12:03:00.000Z';
    assert.equal(tick().code, 0);
    assert.equal(calibrations, 1);
    assert.equal(d.stored.meta.horizon, iso(Date.parse(at) + offsetMs));
  });
}

test('clock calibration adjusts the query start, not its response time', () => {
  const d = deps([[]]);
  const times = ['2026-07-01T12:00:00.000Z', '2026-07-01T12:00:10.000Z'];
  d.now = () => times.shift();
  d.fetchPRs = (_repo, opts) => {
    opts.onServerTime('2026-07-01T12:00:40.000Z');
    return { rows: [], rateLimit: RATE_LIMIT };
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
  assert.equal(d.stored.meta.horizon, '2026-07-01T12:00:30.000Z');
  assert.equal(d.stored.meta.updatedAt, '2026-07-01T12:00:00.000Z');
});

test('error reports carry schemaVersion and omit deltas', () => {
  const d = deps([[basePr]]);
  d.resolveRepo = () => ({ status: 'declined' });
  const { code, report } = run(['--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.equal(report.schemaVersion, 2);
  assert.match(report.error, /--repo/);
  assert.equal(report.deltas, undefined);
  assert.equal(d.writes, 0);
});

test('a delta returns code 10 and rewrites the snapshot', () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 10);
  assert.ok(report.deltas.some((x) => x.classes.includes('merged')));
});

test('no change returns code 0 and still refreshes snapshot', () => {
  const seed = { pr: {}, issue: {} };
  const d = deps([[]], { existing: seed });
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
});

test('a gh failure returns code 1 and does NOT write the snapshot', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({ pr: {}, issue: {}, meta: DEFAULT_OLD_META }),
    writeSnapshotAtomic: () => {
      throw new Error('should not be called');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 1);
});

test('--entities pr preserves existing issue snapshot entries', () => {
  const existing = {
    pr: {
      42: item(openFp),
    },
    issue: { 7: { state: 'open', updatedAt: '2026-07-01T10:00:00Z', labels: [], comments: 0 } },
  };
  const d = deps([[basePr]], { existing });
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.ok(d.stored.issue['7']);
});

test('corrupt snapshot read failure returns code 2 and does NOT write', () => {
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => ({ rows: [basePr], rateLimit: RATE_LIMIT }),
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(writes, 0);
  assert.match(report.results[0].error.message, /invalid snapshot JSON/);
});

test('invalid snapshot horizon returns code 2 before fetching', () => {
  let fetched = false;
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetched = true;
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: 'not-a-date' } }),
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(report.results[0].error.kind, 'snapshot');
  assert.match(report.results[0].error.message, /invalid snapshot horizon/);
  assert.equal(fetched, false);
  assert.equal(writes, 0);
});

test('existing snapshot is read before GitHub fetches', () => {
  let read = false;
  let fetched = false;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      fetchIssues: () => {
        throw new Error('should not fetch');
      },
      readSnapshot: () => {
        read = true;
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(read, true);
  assert.equal(fetched, false);
  assert.match(report.results[0].error.message, /invalid snapshot/);
});

test('error kinds map to exit codes: config/snapshot=2, github/io/busy=1', () => {
  const base = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];
  const noFetch = { ...NOOP_LOCK_DEPS, now: () => '2026-07-01T12:00:00Z' };
  const config = run(
    ['--repo', 'o/r', '--monitor-id', '../bad', '--state-file', '/tmp/x.json'],
    noFetch,
  );
  assert.equal(config.code, 2);
  assert.equal(config.report.kind, 'config');
  const snapshot = run(base, {
    ...noFetch,
    readSnapshot: () => {
      throw new Error('invalid snapshot JSON at /tmp/x.json');
    },
  });
  assert.equal(snapshot.code, 2);
  assert.equal(snapshot.report.results[0].error.kind, 'snapshot');
  const github = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  });
  assert.equal(github.code, 1);
  assert.equal(github.report.results[0].error.kind, 'github');
  const io = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    writeSnapshotAtomic: () => {
      throw new Error('ENOSPC');
    },
  });
  assert.equal(io.code, 1);
  assert.equal(io.report.results[0].error.kind, 'io');
  let fetched = false;
  const busy = run(base, {
    ...noFetch,
    acquireLock: () => ({ ok: false, reason: 'held' }),
    fetchPRs: () => {
      fetched = true;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
  });
  assert.equal(busy.code, 1);
  assert.equal(busy.report.results[0].error.kind, 'busy');
  assert.equal(fetched, false); // busy is raised before any GitHub call
});

test('--gh-timeout-ms abc is a config error (exit 2, kind config)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      'abc',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--gh-timeout-ms/);
});

test('--rate-limit-floor validates before repository derivation or state access', () => {
  for (const floor of ['-1', '1.5', 'nope', '', String(Number.MAX_SAFE_INTEGER + 1)]) {
    let derived = false;
    let read = false;
    const result = run(['--rate-limit-floor', floor], {
      now: () => '2026-07-01T12:00:00Z',
      resolveRepo: () => {
        derived = true;
        return { repo: 'o/r', source: 'gh' };
      },
      readSnapshot: () => {
        read = true;
        return null;
      },
    });
    assert.equal(result.code, 2, floor);
    assert.equal(result.report.kind, 'config', floor);
    assert.match(result.report.error, /--rate-limit-floor/, floor);
    assert.equal(derived, false, floor);
    assert.equal(read, false, floor);
  }
});

test('--rate-limit-floor gates fetch after snapshot read and reports a low quota without writes', () => {
  const order = [];
  let writes = 0;
  let registered;
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--rate-limit-floor',
      '4',
    ],
    {
      ...NOOP_LOCK_DEPS,
      readSnapshot: () => {
        order.push('read');
        return null;
      },
      fetchRateLimit: (_options) => {
        order.push('rate');
        return { remaining: 3, resetAt: '2026-07-01T13:00:00.000Z' };
      },
      fetchPRs: () => {
        order.push('fetch');
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => {
        order.push('fetch');
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      writeSnapshotAtomic: () => {
        writes++;
      },
      registerMonitor: (entry) => {
        registered = entry;
      },
      now: () => '2026-07-01T12:00:00Z',
      env: {},
    },
  );
  assert.equal(result.code, 1);
  assert.equal(result.report.results[0].error.kind, 'rate-limit');
  assert.equal(result.report.results[0].error.resetAt, '2026-07-01T13:00:00.000Z');
  assert.equal(result.report.results[0].error.remaining, 3);
  assert.equal(Object.hasOwn(result.report.results[0].error, 'cost'), false);
  assert.match(result.report.results[0].error.message, /remaining 3.*floor 4/);
  assert.deepEqual(order, ['read', 'rate']);
  assert.equal(writes, 0);
  assert.equal(registered.status, 'failure');
  assert.equal(registered.error.kind, 'rate-limit');
});

test('--rate-limit-floor allows equality and forwards timeout before the observation fetch', () => {
  const order = [];
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--rate-limit-floor',
      '4',
      '--gh-timeout-ms',
      '321',
    ],
    {
      ...NOOP_LOCK_DEPS,
      readSnapshot: () => null,
      fetchRateLimit: (options) => {
        order.push(['rate', options.timeoutMs]);
        return { remaining: 4, resetAt: '2026-07-01T13:00:00.000Z' };
      },
      fetchPRs: () => {
        order.push(['fetch']);
        return { rows: [], rateLimit: RATE_LIMIT };
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      writeSnapshotAtomic: () => {},
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(order, [['rate', 321], ['fetch']]);
});

test('a tick spanning two entity families accumulates cost and keeps the last remaining/resetAt', () => {
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: () => ({
      rows: [],
      rateLimit: { cost: 4, remaining: 100, resetAt: '2026-07-01T13:00:00.000Z' },
    }),
    fetchIssues: () => ({
      rows: [],
      rateLimit: { cost: 2, remaining: 98, resetAt: '2026-07-01T13:00:01.000Z' },
    }),
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    now: () => '2026-07-01T12:00:00Z',
  };
  const result = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(result.code, 0);
  // F3's accumulator, surfaced by R3 as results[].rateLimit.
  assert.deepEqual(result.report.results[0].rateLimit, {
    cost: 6,
    remaining: 98,
    resetAt: '2026-07-01T13:00:01.000Z',
  });
});

test('enrichment cost accumulates into the same tick-level rateLimit as the observation fetches', () => {
  const before = {
    ...basePr,
    conversationComments: 1,
    recentComments: [{ id: 'C1', author: 'old' }],
  };
  const after = {
    ...before,
    updatedAt: '2026-07-01T11:00:00Z',
    conversationComments: 2,
    recentComments: [
      { id: 'C1', author: 'old' },
      { id: 'C2', author: 'new' },
    ],
  };
  const d = deps([[after]], {
    existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} },
  });
  d.fetchPRs = () => ({
    rows: [after],
    rateLimit: { cost: 4, remaining: 100, resetAt: '2026-07-01T13:00:00.000Z' },
  });
  d.fetchEnrichment = () => ({
    rows: [{ id: 'C2', author: 'a', createdAt: 'now', body: 'hi' }],
    rateLimit: { cost: 1, remaining: 99, resetAt: '2026-07-01T13:00:01.000Z' },
  });
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--enrich',
      'comments',
    ],
    d,
  );
  assert.equal(result.code, 10);
  // 4 (PR fetch) + 1 (default issue fetch from deps()) + 1 (enrichment).
  assert.deepEqual(result.report.results[0].rateLimit, {
    cost: 6,
    remaining: 99,
    resetAt: '2026-07-01T13:00:01.000Z',
  });
});

test('omitting --rate-limit-floor makes no rate-limit call', () => {
  let calls = 0;
  const d = deps([[]]);
  d.fetchRateLimit = () => {
    calls++;
    return { remaining: 0, resetAt: '2026-07-01T13:00:00.000Z' };
  };
  run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(calls, 0);
});

test('--gh-timeout-ms threads into fetchers and defaults to 60000', () => {
  let receivedTimeoutMs;
  const makeDeps = () => ({
    ...NOOP_LOCK_DEPS,
    fetchPRs: (_repo, opts) => {
      receivedTimeoutMs = opts.timeoutMs;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    now: () => '2026-07-01T12:00:00Z',
  });

  run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], makeDeps());
  assert.equal(receivedTimeoutMs, 60000);

  run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      '5000',
    ],
    makeDeps(),
  );
  assert.equal(receivedTimeoutMs, 5000);
});

test('the CLI threads the snapshot horizon into fetchers and stamps a new one', () => {
  let receivedCutoff = 'unset';
  const d = {
    ...NOOP_LOCK_DEPS,
    fetchPRs: (_repo, opts) => {
      receivedCutoff = opts.horizonCutoff;
      return { rows: [], rateLimit: RATE_LIMIT };
    },
    fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
    readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: '2026-07-01T11:00:00.000Z' } }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
  assert.equal(receivedCutoff, '2026-07-01T11:00:00.000Z');
  assert.equal(d.written.meta.horizon, '2026-07-01T12:00:00.000Z');
});

test('snapshots are self-describing: meta carries identity next to horizon', () => {
  const d = deps([[basePr]]);
  run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.deepEqual(d.stored.meta, {
    schemaVersion: 2,
    ghDeltaVersion: d.stored.meta.ghDeltaVersion,
    repo: 'o/r',
    monitorId: 'main',
    entities: ['pr'],
    scope: 'poll',
    horizon: '2026-07-01T12:00:00Z',
    createdAt: '2026-07-01T12:00:00Z',
    updatedAt: '2026-07-01T12:00:00Z',
  });
  assert.match(d.stored.meta.ghDeltaVersion, /^\d+\.\d+\.\d+/);
});
