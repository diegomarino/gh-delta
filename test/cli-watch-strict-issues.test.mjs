// Strict issue-only and mixed watch contracts. These assert observable CLI
// behavior: batches, snapshot identity, publication, and rejection.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deps, RATE_LIMIT, basePr } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';
import { economicalSnapshotPath, snapshotPath } from '../lib/snapshot.mjs';
import { addWatch, readWatch, watchFilename } from '../lib/watch.mjs';
import { syncWatch } from '../lib/watch-sync.mjs';

const baseIssue = {
  number: 1,
  title: 'design voice',
  state: 'open',
  updatedAt: '2026-07-01T10:00:00Z',
  id: 'I_1',
  author: 'octocat',
  createdAt: '2026-06-01T00:00:00Z',
  url: 'https://github.com/o/r/issues/1',
  labels: [],
  assignees: [],
  conversationComments: 0,
  recentComments: [],
};

function issueRow(number, over = {}) {
  return {
    ...baseIssue,
    number,
    id: `I_${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    ...over,
  };
}

function writeEntry(dir, entry) {
  const full = { addedAt: '2026-07-01T00:00:00Z', ...entry };
  writeFileSync(join(dir, watchFilename(full)), JSON.stringify(full));
}

function watchDir(prefix, entries) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of entries) writeEntry(dir, entry);
  return dir;
}

function issues(count) {
  return Array.from({ length: count }, (_, index) => ({
    entity: 'issue',
    number: index + 1,
    until: 'closed',
  }));
}

function prs(count) {
  return Array.from({ length: count }, (_, index) => ({
    entity: 'pr',
    number: index + 1,
    until: 'merged',
  }));
}

function guard(d) {
  const calls = [];
  d.fetchPRs = () => {
    throw new Error('broad PR fetch must not run');
  };
  d.fetchIssues = () => {
    throw new Error('broad issue fetch must not run');
  };
  d.fetchPRsByNumber = () => {
    throw new Error('PR-number fetch must not run');
  };
  d.fetchWatchedItems = (_repo, items) => {
    calls.push(items.map((item) => ({ entity: item.entity, number: item.number })));
    return {
      pr: items
        .filter((item) => item.entity === 'pr')
        .map((item) => ({ ...basePr, number: item.number })),
      issue: items.filter((item) => item.entity === 'issue').map((item) => issueRow(item.number)),
      rateLimit: RATE_LIMIT,
    };
  };
  d.fetchRateLimit = () => {
    throw new Error('quota preflight must not run');
  };
  return calls;
}

function strictArgs(dir, state, entities, extra = []) {
  return [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    state,
    '--watch-dir',
    dir,
    '--watch-strict',
    '--entities',
    entities,
    ...extra,
  ];
}

test('issue-only strict watches one, ten, and eleven issues without a broad fetch', () => {
  for (const count of [1, 10, 11]) {
    const dir = watchDir(`gd-strict-issue-${count}-`, issues(count));
    const d = deps([[]]);
    const calls = guard(d);
    const state = join(dir, 'state.json');
    const result = run(strictArgs(dir, state, 'issue'), d);
    assert.equal(
      result.code,
      0,
      `count ${count}: ${result.report.results?.[0]?.error?.message ?? result.report.error}`,
    );
    assert.equal(calls.length, count === 11 ? 2 : 1);
    assert.deepEqual(
      calls[0],
      issues(Math.min(count, 10)).map((entry) => ({ entity: 'issue', number: entry.number })),
    );
    if (count === 11) assert.deepEqual(calls[1], [{ entity: 'issue', number: 11 }]);
    assert.equal(result.report.results[0].stateFile, `${state}.watch-issue.json`);
    assert.equal(d.stored.meta.scope, 'watch-issue');
    assert.deepEqual(d.stored.meta.entities, ['issue']);
    assert.deepEqual(
      Object.keys(d.stored.issue).map(Number),
      issues(count).map((entry) => entry.number),
    );
    assert.deepEqual(d.stored.pr, {});
    assert.equal(result.report.results[0].baseline, true);
    assert.deepEqual(result.report.deltas, []);
  }
});

test('mixed strict batches past ten items in canonical order and does not fetch broadly', () => {
  const dir = watchDir('gd-strict-mixed-', [...prs(12), ...issues(4)]);
  const d = deps([[]]);
  const calls = guard(d);
  const state = join(dir, 'state.json');
  const result = run(strictArgs(dir, state, 'pr,issue'), d);
  assert.equal(result.code, 0);
  assert.deepEqual(
    calls[0],
    Array.from({ length: 10 }, (_, index) => ({ entity: 'pr', number: index + 1 })),
  );
  assert.deepEqual(calls[1], [
    { entity: 'pr', number: 11 },
    { entity: 'pr', number: 12 },
    { entity: 'issue', number: 1 },
    { entity: 'issue', number: 2 },
    { entity: 'issue', number: 3 },
    { entity: 'issue', number: 4 },
  ]);
  assert.equal(result.report.results[0].stateFile, `${state}.watch-pr-issue.json`);
  assert.equal(d.stored.meta.scope, 'watch-pr-issue');
  assert.deepEqual(d.stored.meta.entities, ['pr', 'issue']);
  assert.deepEqual(Object.keys(d.stored.pr).length, 12);
  assert.deepEqual(Object.keys(d.stored.issue).length, 4);
});

test('previously accepted PR-only strict selections keep the watch-pr snapshot', () => {
  for (const entities of ['pr', 'pr,issue']) {
    const dir = watchDir(`gd-strict-pr-compat-${entities}-`, prs(11));
    const d = deps([[]]);
    let numbers = [];
    guard(d);
    d.fetchPRsByNumber = (_repo, batch) => {
      numbers.push([...batch]);
      return {
        rows: batch.map((number) => ({ ...basePr, number })),
        rateLimit: RATE_LIMIT,
      };
    };
    const state = join(dir, 'state.json');
    const result = run(strictArgs(dir, state, entities), d);
    assert.equal(result.code, 0, entities);
    assert.deepEqual(numbers, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
    assert.equal(result.report.results[0].stateFile, `${state}.watch.json`);
    assert.equal(d.stored.meta.scope, 'watch-pr');
    assert.deepEqual(d.stored.meta.entities, ['pr']);
  }
});

test('an empty strict scope makes no GitHub request, including issue-only and mixed', () => {
  for (const [entities, suffix, scope] of [
    ['issue', '.watch-issue.json', 'watch-issue'],
    ['pr,issue', '.watch.json', 'watch-pr'],
    ['pr', '.watch.json', 'watch-pr'],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'gd-strict-empty-scope-'));
    const d = deps([[]]);
    const calls = guard(d);
    const state = join(dir, 'state.json');
    const result = run([...strictArgs(dir, state, entities), '--rate-limit-floor', '100'], d);
    assert.equal(result.code, 0, entities);
    assert.deepEqual(calls, []);
    assert.equal(result.report.results[0].stateFile, `${state}${suffix}`);
    assert.equal(d.stored.meta.scope, scope);
    assert.equal(result.report.results[0].rateLimit ?? null, null);
    assert.deepEqual(d.stored.pr, {});
    assert.deepEqual(d.stored.issue, {});
  }
});

test('invalid, duplicate, and out-of-scope identities fail before fetch or state writes', () => {
  const cases = [
    {
      name: 'unknown entity',
      file: 'widget-1.json',
      body: { entity: 'widget', number: 1, until: 'closed', addedAt: '2026-07-01T00:00:00Z' },
      error: /invalid watch entry/,
    },
    {
      name: 'invalid number',
      file: 'issue-0.json',
      body: { entity: 'issue', number: 0, until: 'closed', addedAt: '2026-07-01T00:00:00Z' },
      error: /invalid watch entry/,
    },
  ];
  for (const scenario of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'gd-strict-bad-id-'));
    writeFileSync(join(dir, scenario.file), JSON.stringify(scenario.body));
    const d = deps([[]]);
    guard(d);
    const result = run(strictArgs(dir, join(dir, 'state.json'), 'issue'), d);
    assert.equal(result.code, 2, scenario.name);
    assert.match(result.report.error ?? result.report.results?.[0]?.error?.message, scenario.error);
    assert.equal(d.writes, 0);
  }

  const dup = mkdtempSync(join(tmpdir(), 'gd-strict-dup-'));
  writeEntry(dup, { entity: 'issue', number: 4, until: 'closed' });
  writeEntry(dup, { entity: 'issue', number: 4, until: 'closed', repo: 'o/r' });
  const dupDeps = deps([[]]);
  guard(dupDeps);
  const duplicated = run(strictArgs(dup, join(dup, 'state.json'), 'issue'), dupDeps);
  assert.equal(duplicated.code, 2);
  assert.match(
    duplicated.report.error ?? duplicated.report.results?.[0]?.error?.message,
    /duplicate/,
  );
  assert.equal(dupDeps.writes, 0);

  const mismatch = watchDir('gd-strict-mismatch-', [
    { entity: 'pr', number: 3, until: 'merged' },
    { entity: 'issue', number: 4, until: 'closed' },
  ]);
  for (const [entities, error] of [
    ['issue', /cannot include pr watch entries/],
    ['pr', /cannot include issue watch entries/],
  ]) {
    const d = deps([[]]);
    guard(d);
    const result = run(strictArgs(mismatch, join(mismatch, `${entities}.json`), entities), d);
    assert.equal(result.code, 2, entities);
    assert.match(result.report.results?.[0]?.error?.message ?? result.report.error, error);
    assert.equal(d.writes, 0);
  }
});

test('the same number in two repositories and both entities stays on its own identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-strict-collide-'));
  const watch = join(root, 'watch');
  const stateDir = join(root, 'state');
  mkdirSync(watch);
  writeEntry(watch, { entity: 'pr', number: 42, until: 'merged', repo: 'o/r' });
  writeEntry(watch, { entity: 'issue', number: 42, until: 'closed', repo: 'a/b' });
  const written = new Map();
  const seen = [];
  const d = deps([[]]);
  guard(d);
  d.fetchPRsByNumber = (repo, numbers) => {
    seen.push({ repo, items: numbers.map((number) => `pr:${number}`) });
    return {
      rows: numbers.map((number) => ({ ...basePr, number, title: `${repo} pr` })),
      rateLimit: RATE_LIMIT,
    };
  };
  d.fetchWatchedItems = (repo, items) => {
    seen.push({ repo, items: items.map((item) => `${item.entity}:${item.number}`) });
    return {
      pr: items
        .filter((item) => item.entity === 'pr')
        .map((item) => ({ ...basePr, number: item.number, title: `${repo} pr` })),
      issue: items
        .filter((item) => item.entity === 'issue')
        .map((item) => issueRow(item.number, { title: `${repo} issue` })),
      rateLimit: RATE_LIMIT,
    };
  };
  d.readSnapshot = (p) => written.get(p) ?? null;
  d.writeSnapshotAtomic = (p, data) => {
    written.set(p, data);
  };
  const result = run(
    [
      '--repo',
      'o/r,a/b',
      '--monitor-id',
      'main',
      '--state-dir',
      stateDir,
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'pr,issue',
    ],
    d,
  );
  assert.equal(result.code, 0, result.report.results?.find((row) => row.error)?.error?.message);
  assert.deepEqual(seen, [
    { repo: 'o/r', items: ['pr:42'] },
    { repo: 'a/b', items: ['issue:42'] },
  ]);
  const prPath = economicalSnapshotPath('o/r', 'main', 'pr', stateDir, { scope: 'watch-pr' });
  const issuePath = economicalSnapshotPath('a/b', 'main', 'pr-issue', stateDir, {
    scope: 'watch-pr-issue',
  });
  assert.notEqual(prPath, issuePath);
  assert.equal(written.get(prPath).pr['42'].context.title, 'o/r pr');
  assert.deepEqual(written.get(prPath).issue, {});
  assert.equal(written.get(issuePath).issue['42'].context.title, 'a/b issue');
  assert.deepEqual(written.get(issuePath).pr, {});
  assert.equal(existsSync(snapshotPath('o/r', 'main', 'pr-issue', stateDir)), false);
});

test('pr and issue with the same number are separate observations', () => {
  const dir = watchDir('gd-strict-same-number-', [
    { entity: 'pr', number: 3, until: 'merged' },
    { entity: 'issue', number: 3, until: 'closed' },
  ]);
  const d = deps([[]]);
  guard(d);
  let tick = 0;
  d.fetchWatchedItems = () => {
    tick += 1;
    return {
      pr: [{ ...basePr, number: 3, title: 'pr three' }],
      issue: [issueRow(3, { title: 'issue three', conversationComments: tick === 1 ? 0 : 1 })],
      rateLimit: RATE_LIMIT,
    };
  };
  const state = join(dir, 'state.json');
  const first = run(strictArgs(dir, state, 'pr,issue'), d);
  assert.equal(first.code, 0);
  const second = run(strictArgs(dir, state, 'pr,issue'), d);
  assert.equal(second.code, 10);
  assert.equal(second.report.deltas.length, 1);
  assert.equal(second.report.deltas[0].entity, 'issue');
  assert.equal(second.report.deltas[0].number, 3);
  assert.ok(second.report.deltas[0].classes.includes('new-comments'));
  assert.equal(d.stored.pr['3'].context.title, 'pr three');
  assert.equal(d.stored.issue['3'].context.title, 'issue three');
});

test('labels survive add and sync and are copied onto emitted issue deltas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-strict-labels-'));
  addWatch(dir, 'issue:42', 'closed', {
    now: () => '2026-07-01T00:00:00Z',
    labels: { project: 'example', task: 'design-voice' },
  });
  syncWatch(dir, 'issue:42 until=closed project=example task=design-voice\nend 1\n', {
    now: () => '2026-07-01T00:00:00Z',
  });
  assert.deepEqual(readWatch(dir)[0].labels, { project: 'example', task: 'design-voice' });
  const d = deps([[]]);
  guard(d);
  let comments = 0;
  d.fetchWatchedItems = () => {
    comments += 1;
    return {
      pr: [],
      issue: [issueRow(42, { conversationComments: comments === 1 ? 0 : 2, recentComments: [] })],
      rateLimit: RATE_LIMIT,
    };
  };
  const state = join(dir, 'state.json');
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  const changed = run([...strictArgs(dir, state, 'issue'), '--log'], d);
  assert.equal(changed.code, 10);
  assert.deepEqual(changed.report.deltas[0].watch.labels, {
    project: 'example',
    task: 'design-voice',
  });
  assert.equal(changed.report.deltas[0].seq, 1);
});

test('a later issue batch failure publishes nothing and keeps the validated cost', () => {
  const dir = watchDir('gd-strict-issue-fail-', [
    ...prs(10),
    { entity: 'issue', number: 4, until: 'closed' },
  ]);
  const d = deps([[]]);
  guard(d);
  let calls = 0;
  let logged = false;
  d.appendDeltaLog = () => {
    logged = true;
    return { fromSeq: 1, toSeq: 1, appended: 1 };
  };
  d.fetchWatchedItems = (_repo, items) => {
    calls += 1;
    if (calls === 2) throw new Error('issue batch failed');
    return {
      pr: items.map((item) => ({ ...basePr, number: item.number })),
      issue: [],
      rateLimit: { cost: 4, remaining: 4990, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const result = run([...strictArgs(dir, join(dir, 'state.json'), 'pr,issue'), '--log'], d);
  assert.equal(result.code, 1);
  assert.equal(calls, 2);
  assert.equal(d.writes, 0);
  assert.equal(logged, false);
  assert.deepEqual(result.report.results[0].rateLimit, {
    cost: 4,
    remaining: 4990,
    resetAt: '2026-07-01T13:00:00Z',
  });
});

test('issue strict quota admission can refuse before any batch and after a successful batch', () => {
  const dir = watchDir('gd-strict-issue-floor-', issues(11));
  const denied = deps([[]]);
  guard(denied);
  let deniedCalls = 0;
  denied.fetchRateLimit = () => ({ remaining: 101, resetAt: '2026-07-01T13:00:00Z' });
  denied.fetchWatchedItems = () => {
    deniedCalls += 1;
    throw new Error('must not fetch');
  };
  const before = run(
    [...strictArgs(dir, join(dir, 'a.json'), 'issue'), '--rate-limit-floor', '100'],
    denied,
  );
  assert.equal(before.code, 1);
  assert.equal(deniedCalls, 0);
  assert.equal(denied.writes, 0);
  assert.equal(before.report.results[0].rateLimit, null);
  assert.match(before.report.results[0].error.message, /2 batch/);

  const mid = deps([[]]);
  guard(mid);
  let midCalls = 0;
  mid.fetchRateLimit = () => ({ remaining: 102, resetAt: '2026-07-01T13:00:00Z' });
  mid.fetchWatchedItems = () => {
    midCalls += 1;
    return {
      pr: [],
      issue: [issueRow(1)],
      rateLimit: { cost: 2, remaining: 100, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const after = run(
    [...strictArgs(dir, join(dir, 'b.json'), 'issue'), '--rate-limit-floor', '100'],
    mid,
  );
  assert.equal(after.code, 1);
  assert.equal(midCalls, 1);
  assert.equal(mid.writes, 0);
  assert.deepEqual(after.report.results[0].rateLimit, {
    cost: 2,
    remaining: 100,
    resetAt: '2026-07-01T13:00:00Z',
  });
  assert.equal(after.report.results[0].error.kind, 'rate-limit');
});

test('issue closure, assignment, relabeling, and comments use the issue classifier', () => {
  const dir = watchDir('gd-strict-classes-', [{ entity: 'issue', number: 42, until: 'closed' }]);
  const d = deps([[]]);
  guard(d);
  const open = issueRow(42, {
    labels: [{ name: 'bug' }],
    assignees: ['ada'],
    conversationComments: 1,
  });
  const closed = issueRow(42, {
    state: 'closed',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'done' }],
    assignees: ['grace'],
    conversationComments: 2,
    recentComments: [{ id: 'C2', author: 'grace' }],
  });
  const rows = [open, closed];
  d.fetchWatchedItems = () => ({ pr: [], issue: [rows.shift()], rateLimit: RATE_LIMIT });
  const state = join(dir, 'state.json');
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  const result = run(strictArgs(dir, state, 'issue'), d);
  assert.equal(result.code, 10);
  assert.deepEqual(result.report.deltas[0].classes.sort(), [
    'assignees-changed',
    'closed',
    'new-comments',
    'relabeled',
  ]);
  assert.equal(result.report.deltas[0].entity, 'issue');
  for (const field of ['headSha', 'isDraft', 'reviewDecision', 'mergeable', 'checks', 'reviews']) {
    assert.equal(Object.hasOwn(result.report.deltas[0].to, field), false);
  }
});

test('removing an issue projects it out, and retirement does not keep watching a reopening', () => {
  const dir = watchDir('gd-strict-project-', [
    { entity: 'issue', number: 7, until: 'closed' },
    { entity: 'issue', number: 8, until: 'closed' },
  ]);
  const d = deps([[]]);
  guard(d);
  const seen = [];
  d.fetchWatchedItems = (_repo, items) => {
    seen.push(items.map((item) => item.number));
    return {
      pr: [],
      issue: items.map((item) => issueRow(item.number)),
      rateLimit: RATE_LIMIT,
    };
  };
  const state = join(dir, 'state.json');
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  rmSync(join(dir, 'issue-7.json'));
  const projected = run(strictArgs(dir, state, 'issue'), d);
  assert.equal(projected.code, 0);
  assert.deepEqual(projected.report.deltas, []);
  assert.deepEqual(Object.keys(d.stored.issue), ['8']);
  assert.deepEqual(seen.at(-1), [8]);

  const terminalDir = watchDir('gd-strict-retire-', [
    { entity: 'issue', number: 42, until: 'closed' },
  ]);
  const terminal = deps([[]]);
  guard(terminal);
  const phases = [
    issueRow(42),
    issueRow(42, { state: 'closed', updatedAt: '2026-07-01T11:00:00Z' }),
    issueRow(42, { state: 'open', updatedAt: '2026-07-01T12:00:00Z' }),
  ];
  let fetches = 0;
  terminal.fetchWatchedItems = () => {
    fetches += 1;
    return { pr: [], issue: [phases[fetches - 1]], rateLimit: RATE_LIMIT };
  };
  const terminalState = join(terminalDir, 'state.json');
  assert.equal(run(strictArgs(terminalDir, terminalState, 'issue'), terminal).code, 0);
  const closed = run(strictArgs(terminalDir, terminalState, 'issue'), terminal);
  assert.equal(closed.code, 10);
  assert.ok(closed.report.deltas[0].classes.includes('closed'));
  assert.equal(existsSync(join(terminalDir, 'issue-42.json')), false);
  const reopened = run(strictArgs(terminalDir, terminalState, 'issue'), terminal);
  assert.equal(reopened.code, 0);
  assert.equal(fetches, 2);
  assert.deepEqual(reopened.report.deltas, []);
  assert.deepEqual(terminal.stored.issue, {});
});

test('re-adding a projected issue is a new observation', () => {
  const dir = watchDir('gd-strict-readd-', [{ entity: 'issue', number: 9, until: 'closed' }]);
  const d = deps([[]]);
  guard(d);
  d.fetchWatchedItems = () => ({ pr: [], issue: [issueRow(9)], rateLimit: RATE_LIMIT });
  const state = join(dir, 'state.json');
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  rmSync(join(dir, 'issue-9.json'));
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  assert.deepEqual(d.stored.issue, {});
  writeEntry(dir, { entity: 'issue', number: 9, until: 'closed' });
  const again = run(strictArgs(dir, state, 'issue'), d);
  assert.equal(again.code, 10);
  assert.deepEqual(again.report.deltas[0].classes, ['new']);
});

test('a still-watched null issue becomes missing, and a bad alias does not publish', () => {
  const dir = watchDir('gd-strict-null-', [{ entity: 'issue', number: 5, until: 'closed' }]);
  const d = deps([[]]);
  guard(d);
  const responses = [
    { pr: [], issue: [issueRow(5)], rateLimit: RATE_LIMIT },
    { pr: [], issue: [], rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-07-01T13:00:00Z' } },
  ];
  d.fetchWatchedItems = () => responses.shift();
  const state = join(dir, 'state.json');
  assert.equal(run(strictArgs(dir, state, 'issue'), d).code, 0);
  const missing = run(strictArgs(dir, state, 'issue'), d);
  assert.equal(missing.code, 10);
  assert.deepEqual(missing.report.deltas[0].classes, ['missing']);
  assert.equal(missing.report.deltas[0].entity, 'issue');

  const badDir = watchDir('gd-strict-bad-alias-', [...prs(10), ...issues(1)]);
  const bad = deps([[]]);
  guard(bad);
  let calls = 0;
  bad.fetchWatchedItems = () => {
    calls += 1;
    if (calls === 2)
      throw new Error('GitHub GraphQL fetch for o/r returned unexpected shape (issue1 type)');
    return {
      pr: Array.from({ length: 10 }, (_, index) => ({ ...basePr, number: index + 1 })),
      issue: [],
      rateLimit: { cost: 3, remaining: 10, resetAt: '2026-07-01T13:00:00Z' },
    };
  };
  const failed = run(strictArgs(badDir, join(badDir, 'state.json'), 'pr,issue'), bad);
  assert.equal(failed.code, 1);
  assert.equal(bad.writes, 0);
  assert.equal(failed.report.results[0].rateLimit.cost, 3);
  assert.match(failed.report.results[0].error.message, /issue1 type/);
});

test('ordinary issue and broad mixed watches stay on the poll snapshot', () => {
  const dir = watchDir('gd-ordinary-issue-', issues(2));
  const d = deps([[]]);
  guard(d);
  let broad = 0;
  d.fetchIssues = () => {
    broad += 1;
    return { rows: [issueRow(1), issueRow(2)], rateLimit: RATE_LIMIT };
  };
  const state = join(dir, 'state.json');
  const issueOnly = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      dir,
      '--entities',
      'issue',
    ],
    d,
  );
  assert.equal(issueOnly.code, 0);
  assert.equal(broad, 1);
  assert.equal(issueOnly.report.results[0].stateFile, state);

  const mixed = watchDir('gd-ordinary-mixed-', [
    { entity: 'pr', number: 1, until: 'merged' },
    { entity: 'issue', number: 2, until: 'closed' },
  ]);
  const broadDeps = deps([[basePr]]);
  guard(broadDeps);
  broadDeps.fetchPRs = () => ({ rows: [{ ...basePr, number: 1 }], rateLimit: RATE_LIMIT });
  broadDeps.fetchIssues = () => ({ rows: [issueRow(2)], rateLimit: RATE_LIMIT });
  const mixedResult = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      join(mixed, 'state.json'),
      '--watch-dir',
      mixed,
      '--entities',
      'pr,issue',
    ],
    broadDeps,
  );
  assert.equal(mixedResult.code, 0);
  assert.equal(mixedResult.report.results[0].stateFile, join(mixed, 'state.json'));
  assert.equal(broadDeps.stored.meta.scope, 'poll');
});

test('a new strict identity does not overwrite an existing poll or watch-pr snapshot', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gd-strict-upgrade-'));
  const watch = watchDir('gd-strict-upgrade-watch-', issues(1));
  const poll = snapshotPath('o/r', 'keep', 'issue', stateDir);
  const watchPr = economicalSnapshotPath('o/r', 'keep', 'pr', stateDir);
  writeFileSync(poll, '{"keep":"poll"}\n');
  writeFileSync(watchPr, '{"keep":"watch-pr"}\n');
  const d = deps([[]]);
  guard(d);
  const result = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'keep',
      '--state-dir',
      stateDir,
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'issue',
    ],
    d,
  );
  assert.equal(result.code, 0);
  assert.match(d.writePath, /__watch-issue\.json$/);
  assert.notEqual(d.writePath, poll);
  assert.notEqual(d.writePath, watchPr);
  assert.equal(readFileSync(poll, 'utf8'), '{"keep":"poll"}\n');
  assert.equal(readFileSync(watchPr, 'utf8'), '{"keep":"watch-pr"}\n');
});

test('issue strict omit-end is quiet on a baseline and templates render issue deltas', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'gd-strict-omit-'));
  const quietDeps = deps([[]]);
  guard(quietDeps);
  const quiet = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      join(empty, 'state.json'),
      '--watch-dir',
      empty,
      '--watch-strict',
      '--entities',
      'issue',
      '--format',
      'ndjson',
      '--omit-end',
    ],
    quietDeps,
  );
  assert.equal(quiet.code, 0);
  assert.equal(quiet.output, '');

  const dir = watchDir('gd-strict-template-', [{ entity: 'issue', number: 42, until: 'closed' }]);
  const d = deps([[]]);
  guard(d);
  const rows = [issueRow(42), issueRow(42, { state: 'closed', updatedAt: '2026-07-01T11:00:00Z' })];
  d.fetchWatchedItems = () => ({ pr: [], issue: [rows.shift()], rateLimit: RATE_LIMIT });
  const args = [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    join(dir, 'state.json'),
    '--watch-dir',
    dir,
    '--watch-strict',
    '--entities',
    'issue',
    '--format',
    'template',
    '--template',
    '{entity} #{number} [{classes}]',
  ];
  const baseline = await runCommand(args, d);
  assert.equal(baseline.code, 0);
  assert.equal(baseline.output, '');
  const rendered = await runCommand(args, d);
  assert.equal(rendered.code, 10);
  assert.match(rendered.output, /^issue #42 \[closed\]\n$/);
});

test('one repository can publish when a later repository issue batch fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'gd-strict-repo-fail-'));
  const watch = join(root, 'watch');
  mkdirSync(watch);
  writeEntry(watch, { entity: 'issue', number: 1, until: 'closed', repo: 'o/r' });
  writeEntry(watch, { entity: 'issue', number: 2, until: 'closed', repo: 'a/b' });
  const written = new Map();
  const d = deps([[]]);
  guard(d);
  d.fetchWatchedItems = (repo) => {
    if (repo === 'a/b') throw new Error('issue batch failed');
    return { pr: [], issue: [issueRow(1, { title: 'kept' })], rateLimit: RATE_LIMIT };
  };
  d.readSnapshot = (path) => written.get(path) ?? null;
  d.writeSnapshotAtomic = (path, data) => {
    written.set(path, data);
  };
  const result = run(
    [
      '--repo',
      'o/r,a/b',
      '--monitor-id',
      'main',
      '--state-dir',
      join(root, 'state'),
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'issue',
    ],
    d,
  );
  assert.equal(result.code, 1);
  assert.equal(written.size, 1);
  const [path, snapshot] = [...written.entries()][0];
  assert.match(path, /repo-o%2Fr__/);
  assert.match(path, /__watch-issue\.json$/);
  assert.equal(snapshot.issue['1'].context.title, 'kept');
  assert.equal(result.report.results[1].error.kind, 'github');
});

test('status reads the issue and mixed strict snapshots and a mixed tick leaves watch-pr in place', () => {
  const issueWatch = watchDir('gd-strict-status-issue-', issues(1));
  const issueState = join(issueWatch, 'state.json');
  const issueDeps = deps([[]]);
  guard(issueDeps);
  issueDeps.fetchWatchedItems = () => ({
    pr: [],
    issue: [issueRow(1, { title: 'watched issue' })],
    rateLimit: RATE_LIMIT,
  });
  const issueTick = run(strictArgs(issueWatch, issueState, 'issue'), issueDeps);
  assert.equal(issueTick.code, 0);
  assert.match(issueDeps.writePath, /\.watch-issue\.json$/);
  issueDeps.fetchWatchedItems = () => {
    throw new Error('status must not fetch');
  };
  const issueStatus = run(
    [
      'status',
      '--repo',
      'o/r',
      '--state-file',
      issueState,
      '--watch-dir',
      issueWatch,
      '--watch-strict',
      '--entities',
      'issue',
    ],
    issueDeps,
  );
  assert.equal(issueStatus.code, 0);
  assert.equal(issueStatus.report.stateFile, issueDeps.writePath);
  assert.equal(issueDeps.readPath, issueDeps.writePath);
  assert.equal(issueStatus.report.items[0].title, 'watched issue');

  const root = mkdtempSync(join(tmpdir(), 'gd-strict-mixed-keep-'));
  const watch = watchDir('gd-strict-mixed-keep-watch-', [
    { entity: 'pr', number: 3, until: 'merged' },
    { entity: 'issue', number: 42, until: 'closed' },
  ]);
  const poll = snapshotPath('o/r', 'keep', 'pr-issue', root);
  const watchPr = economicalSnapshotPath('o/r', 'keep', 'pr', root, { scope: 'watch-pr' });
  const watchIssue = economicalSnapshotPath('o/r', 'keep', 'issue', root, { scope: 'watch-issue' });
  writeFileSync(poll, '{"keep":"poll"}\n');
  writeFileSync(watchPr, '{"keep":"watch-pr"}\n');
  writeFileSync(watchIssue, '{"keep":"watch-issue"}\n');
  const mixedDeps = deps([[]]);
  guard(mixedDeps);
  mixedDeps.fetchWatchedItems = () => ({
    pr: [{ ...basePr, number: 3, title: 'worker' }],
    issue: [issueRow(42, { title: 'blocker' })],
    rateLimit: RATE_LIMIT,
  });
  const mixed = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'keep',
      '--state-dir',
      root,
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'pr,issue',
    ],
    mixedDeps,
  );
  assert.equal(mixed.code, 0);
  assert.match(mixedDeps.writePath, /__watch-pr-issue\.json$/);
  assert.notEqual(mixedDeps.writePath, watchPr);
  assert.notEqual(mixedDeps.writePath, watchIssue);
  assert.notEqual(mixedDeps.writePath, poll);
  assert.equal(readFileSync(poll, 'utf8'), '{"keep":"poll"}\n');
  assert.equal(readFileSync(watchPr, 'utf8'), '{"keep":"watch-pr"}\n');
  assert.equal(readFileSync(watchIssue, 'utf8'), '{"keep":"watch-issue"}\n');
  mixedDeps.fetchWatchedItems = () => {
    throw new Error('status must not fetch');
  };
  const mixedStatus = run(
    [
      'status',
      '--repo',
      'o/r',
      '--monitor-id',
      'keep',
      '--state-dir',
      root,
      '--watch-dir',
      watch,
      '--watch-strict',
      '--entities',
      'pr,issue',
    ],
    mixedDeps,
  );
  assert.equal(mixedStatus.code, 0);
  assert.equal(mixedStatus.report.stateFile, mixedDeps.writePath);
  assert.equal(mixedDeps.readPath, mixedDeps.writePath);
  assert.deepEqual(
    mixedStatus.report.items.map((item) => [item.entity, item.number, item.title]),
    [
      ['issue', 42, 'blocker'],
      ['pr', 3, 'worker'],
    ],
  );
});

test('strict help names the issue and mixed snapshot identities', async () => {
  const help = await runCommand(['--help-json']);
  assert.match(help.output, /watch-issue/);
  assert.match(help.output, /watch-pr-issue/);
  const status = await runCommand(['status', '--help-json']);
  assert.match(status.output, /watch-issue/);
});
