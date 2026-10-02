import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTemplate, renderTemplateLines } from '../lib/template.mjs';
import { setCursorAtomic, appendDeltaLog, compactDeltaLog } from '../lib/deltalog.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';

const guide = ['presentation', 'files-and-verification', 'replay-and-errors']
  .map((name) =>
    readFileSync(new URL(`../docs/guides/templates/${name}.md`, import.meta.url), 'utf8'),
  )
  .join('\n');
const sample = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
const cli = fileURLToPath(new URL('../gh-delta.mjs', import.meta.url));
const pinned = 'thread={watch.labels.thread} {repo} #{number} [{classes}]';
const digest = 'eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba';

test('worked examples render their documented bytes from the published fragment', () => {
  for (const [template, expected] of [
    ['{entity} #{number} [{classes}]', 'pr #42 [became-conflicting,head-changed]'],
    [
      'thread={watch.labels.thread} package={watch.labels.package}: {repo} #{number} [{classes}]',
      'thread=t-0004 package=F001-P05: acme/widgets #42 [became-conflicting,head-changed]',
    ],
    [
      'PR #{number}: CI={summary.ciRollup}; review={summary.reviewDecision}; mergeable={summary.mergeable}; unresolved={summary.unresolvedReviewThreads}; draft={summary.isDraft}',
      'PR #42: CI=none; review=review_required; mergeable=conflicting; unresolved=0; draft=false',
    ],
    [pinned, 'thread=t-0004 acme/widgets #42 [became-conflicting,head-changed]'],
    [
      'seq={seq} {watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}',
      'seq=17 t-0004: acme/widgets #42 {state=open}',
    ],
  ]) {
    assert.ok(guide.includes(template), template);
    assert.ok(guide.includes(expected), expected);
    assert.equal(renderTemplateLines(compileTemplate(template), [sample]), `${expected}\n`);
  }
  assert.equal(
    compileTemplate(
      'thread={watch.labels.thread} package={watch.labels.package}: {repo} #{number} [{classes}]',
    )({ ...sample, watch: undefined }),
    'thread= package=: acme/widgets #42 [became-conflicting,head-changed]',
  );
});

function fixture(dir, delta = sample) {
  const logFile = join(dir, 'journal.ndjson');
  const cursor = join(dir, 'cursor.json');
  const records = Array.from({ length: 17 }, (_, i) => {
    const data = { ...delta, id: `d-${i + 1}`, number: i === 16 ? 42 : 1 };
    delete data.repo;
    delete data.seq;
    return {
      seq: i + 1,
      id: data.id,
      detectedAt: '2026-07-01T12:00:00Z',
      repo: 'acme/widgets',
      monitorId: 'example',
      delta: data,
    };
  });
  rmSync(logFile, { force: true });
  rmSync(`${logFile}.published.json`, { force: true });
  appendDeltaLog(logFile, {
    repo: 'acme/widgets',
    monitorId: 'example',
    detectedAt: '2026-07-01T12:00:00Z',
    deltas: records.map((entry) => entry.delta),
  });
  setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
  return { logFile, cursor };
}

function read(cursor, args, cwd) {
  return spawnSync(
    process.execPath,
    [cli, 'read', '--cursor', cursor, '--number', '42', '--format', 'template', ...args],
    {
      cwd,
      env: { ...process.env, GH_DELTA_NO_REGISTRY: '1' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
}

test('real CLI replay renders journal metadata, pins file bytes, and advances scanned tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-replay-'));
  try {
    const { cursor } = fixture(dir);
    const before = readFileSync(cursor);
    const replayTemplate =
      'seq={seq} {watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}';
    const replay = read(cursor, ['--template', replayTemplate], dir);
    assert.equal(replay.status, 10, replay.stderr);
    assert.equal(replay.stdout, 'seq=17 t-0004: acme/widgets #42 {state=open}\n');
    assert.equal(replay.stderr, '');
    assert.deepEqual(readFileSync(cursor), before);
    const path = join(dir, 'template.txt');
    writeFileSync(path, pinned + '\n');
    const inline = read(cursor, ['--template', pinned], dir);
    const file = read(
      cursor,
      ['--template-file', 'template.txt', '--template-sha256', digest.toUpperCase()],
      dir,
    );
    assert.deepEqual(
      [file.status, file.stdout, file.stderr],
      [inline.status, inline.stdout, inline.stderr],
    );
    assert.equal(file.stdout, 'thread=t-0004 acme/widgets #42 [became-conflicting,head-changed]\n');
    const advance = read(cursor, ['--advance', '--template', replayTemplate], dir);
    assert.equal(advance.status, 10);
    assert.equal(advance.stdout, replay.stdout);
    assert.equal(JSON.parse(readFileSync(cursor)).seq, 17);
    const quiet = read(cursor, ['--template', replayTemplate], dir);
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);
    const consumed = readFileSync(cursor);
    const typo = read(cursor, ['--advance', '--template', '{summary.typo}'], dir);
    assert.equal(typo.status, 2);
    assert.equal(typo.stdout, '');
    assert.match(typo.stderr, /path is unknown/);
    assert.deepEqual(readFileSync(cursor), consumed);
    writeFileSync(path, pinned + '\r\n');
    const mismatch = read(
      cursor,
      ['--advance', '--template-file', path, '--template-sha256', digest],
      dir,
    );
    assert.equal(mismatch.status, 2);
    assert.equal(mismatch.stdout, '');
    assert.match(mismatch.stderr, /sha256/);
    assert.deepEqual(readFileSync(cursor), consumed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real CLI read escapes injected controls and preserves optional null/false/zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-values-'));
  try {
    const { cursor } = fixture(dir, {
      ...sample,
      watch: undefined,
      context: { title: 'Fix widget\n{summary.state}\t\\\u007f\u2028' },
    });
    const result = read(
      cursor,
      [
        '--template',
        '{watch.labels.thread}|{context.title}|{summary.isDraft}|{summary.unresolvedReviewThreads}',
      ],
      dir,
    );
    assert.equal(result.status, 10, result.stderr);
    assert.equal(result.stdout, '|Fix widget\\n{summary.state}\\t\\\\\\u007f\\u2028|false|0\n');
    fixture(dir, { ...sample, summary: null });
    const absent = read(cursor, ['--template', 'PR #{number}: state={summary.state}'], dir);
    assert.equal(absent.stdout, 'PR #42: state=\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real CLI read lock contention and invalid logs leave cursor unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-lock-'));
  try {
    const { cursor, logFile } = fixture(dir);
    const before = readFileSync(cursor);
    const lock = acquireLock(cursor, { ghTimeoutMs: 5000, staleMs: 30000 });
    assert.equal(lock.ok, true);
    try {
      const busy = read(cursor, ['--advance', '--template', '{seq}'], dir);
      assert.equal(busy.status, 1);
      assert.equal(busy.stdout, '');
      assert.match(busy.stderr, /locked/);
      assert.deepEqual(readFileSync(cursor), before);
    } finally {
      releaseLock(cursor, lock.token);
    }
    writeFileSync(logFile, 'invalid\n');
    const malformed = read(cursor, ['--advance', '--template', '{seq}'], dir);
    assert.equal(malformed.status, 2);
    assert.equal(malformed.stdout, '');
    assert.match(malformed.stderr, /invalid delta log/);
    assert.deepEqual(readFileSync(cursor), before);
    rmSync(logFile);
    const missing = read(cursor, ['--advance', '--template', '{seq}'], dir);
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout, '');
    assert.deepEqual(readFileSync(cursor), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real CLI read emits retention warnings on stderr and advances through filtered rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-template-retention-'));
  try {
    const { cursor, logFile } = fixture(dir);
    compactDeltaLog(logFile, { keep: { count: 1 } });
    const result = read(
      cursor,
      ['--advance', '--only-classes', 'merged', '--template', '{seq}'],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'gh-delta: warning {"label":"retention","reason":"cursor behind retention"}\n',
    );
    assert.equal(JSON.parse(readFileSync(cursor)).seq, 17);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
