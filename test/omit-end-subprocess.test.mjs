import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function emptyGraphql() {
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-07-01T13:00:00.000Z' },
      repository: { items: { nodes: [], pageInfo: { hasNextPage: false } } },
    },
  });
}

function prGraphql() {
  const page = { nodes: [], pageInfo: { hasNextPage: false } };
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-07-01T13:00:00.000Z' },
      repository: {
        items: {
          nodes: [
            {
              number: 1,
              title: 'widget',
              state: 'OPEN',
              updatedAt: '2026-07-01T11:00:00Z',
              isDraft: false,
              mergeable: 'UNKNOWN',
              mergeStateStatus: 'UNKNOWN',
              reviewDecision: null,
              totalCommentsCount: 0,
              headRefOid: 'abc',
              headRefName: 'feat',
              baseRefName: 'main',
              id: 'PR_1',
              author: { login: 'a' },
              createdAt: '2026-07-01T10:00:00Z',
              url: 'https://example.test/o/r/pull/1',
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: page } } }] },
              latestReviews: page,
              comments: { totalCount: 0, nodes: [] },
              reviewThreads: { totalCount: 0, ...page },
              labels: page,
              assignees: page,
              reviewRequests: page,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
}

function writeFakeGh(binDir, { payload } = {}) {
  mkdirSync(binDir, { recursive: true });
  const payloadPath = join(binDir, 'payload.json');
  writeFileSync(payloadPath, payload ?? emptyGraphql());
  writeFileSync(
    join(binDir, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then',
      '  echo \'{"resources":{"graphql":{"remaining":5000,"reset":1}}}\'',
      '  exit 0',
      'fi',
      'if [ "$FAKE_GH_FAIL" = "1" ]; then',
      "  echo 'boom' >&2",
      '  exit 1',
      'fi',
      'case "$*" in',
      '  *"nodes(ids:"*)',
      '    printf \'%s\\n\' \'{"errors":[{"message":"body unavailable\\nretry later"}]}\'',
      '    exit 0',
      '    ;;',
      'esac',
      'cat "$FAKE_GH_PAYLOAD"',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  return payloadPath;
}

function runTick({ dir, binDir, payloadPath, args = [], format = 'ndjson' }) {
  return spawnSync(
    process.execPath,
    [
      'gh-delta.mjs',
      '--repo',
      'o/r',
      '--monitor-id',
      'sub',
      '--state-dir',
      join(dir, 'state'),
      '--format',
      format,
      ...(format === 'ndjson' ? ['--omit-end'] : []),
      '--entities',
      'pr',
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_DELTA_NO_REGISTRY: '1',
        FAKE_GH_PAYLOAD: payloadPath,
      },
      encoding: 'utf8',
    },
  );
}

test('omit-end subprocess quiet ticks match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-sub-'));
  const binDir = join(dir, 'bin');
  const payloadPath = writeFakeGh(binDir, { payload: emptyGraphql() });
  const baseline = runTick({ dir, binDir, payloadPath });
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stdout, '');
  assert.equal(baseline.stderr, '');

  writeFileSync(payloadPath, prGraphql());
  const event = runTick({ dir, binDir, payloadPath });
  assert.equal(event.status, 10, event.stderr);
  const eventLines = event.stdout.trimEnd().split('\n');
  assert.equal(JSON.parse(eventLines[0]).type, 'delta');
  assert.equal(
    eventLines.some((line) => JSON.parse(line).type === 'end'),
    false,
  );

  const quiet1 = runTick({ dir, binDir, payloadPath });
  const quiet2 = runTick({ dir, binDir, payloadPath });
  assert.equal(quiet1.status, 0);
  assert.equal(quiet1.stdout, '');
  assert.equal(quiet1.stderr, '');
  assert.deepEqual(
    [quiet1.status, quiet1.stdout, quiet1.stderr],
    [quiet2.status, quiet2.stdout, quiet2.stderr],
  );
});

test('omit-end subprocess enrichment warning stays on stderr without changing delta status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-sub-warning-'));
  const binDir = join(dir, 'bin');
  const payloadPath = writeFakeGh(binDir);
  const baseline = runTick({ dir, binDir, payloadPath });
  assert.equal(baseline.status, 0, baseline.stderr);

  writeFileSync(payloadPath, prGraphql());
  const result = runTick({ dir, binDir, payloadPath, args: ['--enrich', 'body'] });
  assert.equal(result.status, 10, result.stderr);
  const lines = result.stdout.trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'delta');
  assert.equal(
    result.stderr,
    'gh-delta: warning {"label":"enrichment body","reason":"GitHub enrichment returned errors: body unavailable\\nretry later"}\n',
  );
});

test('omit-end subprocess failure is empty stdout and prefixed stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-omit-end-sub-fail-'));
  const binDir = join(dir, 'bin');
  const payloadPath = writeFakeGh(binDir);
  const result = spawnSync(
    process.execPath,
    [
      'gh-delta.mjs',
      '--repo',
      'o/r',
      '--monitor-id',
      'sub-fail',
      '--state-dir',
      join(dir, 'state'),
      '--format',
      'ndjson',
      '--omit-end',
      '--entities',
      'pr',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_DELTA_NO_REGISTRY: '1',
        FAKE_GH_PAYLOAD: payloadPath,
        FAKE_GH_FAIL: '1',
      },
      encoding: 'utf8',
    },
  );
  assert.ok(result.status === 1 || result.status === 2, String(result.status));
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^gh-delta: error /);
});

test('template subprocess preserves quiet, delta, warning and failure exit/output tuples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-sub-'));
  try {
    const binDir = join(dir, 'bin');
    const payloadPath = writeFakeGh(binDir);
    const tick = (args = []) =>
      runTick({
        dir,
        binDir,
        payloadPath,
        format: 'template',
        args: ['--template={repo} #{number} [{classes}]', ...args],
      });
    const baseline = tick();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.stdout, '');
    assert.equal(baseline.stderr, '');
    writeFileSync(payloadPath, prGraphql());
    const event = tick(['--log', '--enrich', 'body']);
    assert.equal(event.status, 10, event.stderr);
    assert.equal(event.stdout, 'o/r #1 [new]\n');
    assert.equal(
      event.stderr,
      'gh-delta: warning {"label":"enrichment body","reason":"GitHub enrichment returned errors: body unavailable\\nretry later"}\n',
    );
    const quiet = tick();
    const quietAgain = tick();
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);
    assert.deepEqual([quietAgain.status, quietAgain.stdout, quietAgain.stderr], [0, '', '']);
    const state = readFileSync(join(dir, 'state', 'repo-o%2Fr__monitor-sub__pr.json'));
    const invalid = runTick({
      dir,
      binDir,
      payloadPath,
      format: 'template',
      args: ['--template', '{summary.typo}'],
    });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /path is unknown/);
    assert.deepEqual(readFileSync(join(dir, 'state', 'repo-o%2Fr__monitor-sub__pr.json')), state);
    const env = {
      ...process.env,
      GH_DELTA_NO_REGISTRY: '1',
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GH_PAYLOAD: payloadPath,
      FAKE_GH_FAIL: '1',
    };
    const failure = spawnSync(
      process.execPath,
      [
        'gh-delta.mjs',
        '--repo',
        'o/r',
        '--state-dir',
        join(dir, 'failure'),
        '--format',
        'template',
        '--template',
        '{number}',
      ],
      { cwd: root, env, encoding: 'utf8' },
    );
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /^gh-delta: error /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
