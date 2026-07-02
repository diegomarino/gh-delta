#!/usr/bin/env node
// Live GitHub playground e2e: prove remote mutations activate local gh-delta.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDeltaClass,
  defaultPlaygroundRepoName,
  detectorResultFromProcess,
  parseRepoSpec,
  safeRunId,
  shouldDeletePlaygroundRepo,
} from './playground-e2e-helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GH_DELTA_BIN = join(REPO_ROOT, 'gh-delta.mjs');
const DEFAULT_TMP_ROOT = '/private/tmp/gh-delta-playground-e2e';
const E2E_LABEL = 'gh-delta-e2e';
const E2E_LABEL_UPDATED = 'gh-delta-e2e-updated';

function run(cmd, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const code = result.status ?? 1;
  if (!allowFailure && code !== 0) {
    throw new Error(
      [
        `command failed (${code}): ${cmd} ${args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return { code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gh(args, options = {}) {
  return run('gh', args, options);
}

function git(args, cwd, options = {}) {
  return run('git', args, { cwd, ...options });
}

function log(message) {
  console.log(`[playground-e2e] ${message}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseIssueOrPrNumber(url) {
  const number = Number(url.trim().match(/\/(\d+)$/)?.[1]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`could not parse GitHub number from URL: ${url}`);
  }
  return number;
}

function ensurePrivateRepo(repo) {
  const viewed = gh(['repo', 'view', repo, '--json', 'nameWithOwner,visibility'], {
    allowFailure: true,
  });

  if (viewed.code === 0) {
    const metadata = JSON.parse(viewed.stdout);
    if (metadata.visibility !== 'PRIVATE') {
      throw new Error(`refusing to use non-private playground repo ${repo}`);
    }
    log(`using existing private repo ${metadata.nameWithOwner}`);
    return false;
  }

  log(`creating private repo ${repo}`);
  gh([
    'repo',
    'create',
    repo,
    '--private',
    '--add-readme',
    '--disable-wiki',
    '--description',
    'Private gh-delta live e2e playground',
  ]);
  return true;
}

function deleteRepo(repo) {
  log(`deleting private repo ${repo}`);
  gh(['repo', 'delete', repo, '--yes']);
}

function ensureLabels(repo) {
  gh([
    'label',
    'create',
    E2E_LABEL,
    '-R',
    repo,
    '--color',
    '1D76DB',
    '--description',
    'Created by gh-delta playground e2e',
    '--force',
  ]);
  gh([
    'label',
    'create',
    E2E_LABEL_UPDATED,
    '-R',
    repo,
    '--color',
    '0E8A16',
    '--description',
    'Updated by gh-delta playground e2e',
    '--force',
  ]);
}

function cloneRepo(repo, cloneDir) {
  gh(['repo', 'clone', repo, cloneDir]);
  git(['config', 'user.name', 'gh-delta e2e'], cloneDir);
  git(['config', 'user.email', 'gh-delta-e2e@example.invalid'], cloneDir);
}

function ensureBaseCommit(cloneDir) {
  const head = git(['rev-parse', '--verify', 'HEAD'], cloneDir, { allowFailure: true });
  if (head.code === 0) return git(['branch', '--show-current'], cloneDir).stdout.trim();

  const baseBranch = 'main';
  git(['checkout', '-b', baseBranch], cloneDir);
  writeFileSync(join(cloneDir, 'README.md'), '# gh-delta playground\n');
  git(['add', 'README.md'], cloneDir);
  git(['commit', '-m', 'chore: seed playground'], cloneDir);
  git(['push', '-u', 'origin', baseBranch], cloneDir);
  return baseBranch;
}

function runDelta(repo, monitorId, stateDir) {
  const result = run(
    process.execPath,
    [
      GH_DELTA_BIN,
      '--repo',
      repo,
      '--monitor-id',
      monitorId,
      '--state-dir',
      stateDir,
      '--entities',
      'pr,issue',
      '--format',
      'json',
      '--detail',
    ],
    { allowFailure: true },
  );

  return detectorResultFromProcess(result);
}

function expectDelta(step, repo, monitorId, stateDir, entity, number, klass) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = runDelta(repo, monitorId, stateDir);
    if (result.code === 10) {
      assertDeltaClass(result, entity, number, klass);
      log(`${step}: observed ${entity} #${number} ${klass}`);
      return result;
    }

    if (attempt < 6) sleep(1500);
  }

  const finalResult = runDelta(repo, monitorId, stateDir);
  assertDeltaClass(finalResult, entity, number, klass);
  return finalResult;
}

function createIssue(repo, runId) {
  const created = gh([
    'issue',
    'create',
    '-R',
    repo,
    '--title',
    `gh-delta e2e issue ${runId}`,
    '--body',
    `Created by gh-delta playground e2e run ${runId}.`,
    '--label',
    E2E_LABEL,
  ]);
  return parseIssueOrPrNumber(created.stdout);
}

function createPullRequest(repo, cloneDir, baseBranch, runId) {
  const branch = `gh-delta-e2e-${runId}`;
  git(['checkout', baseBranch], cloneDir);
  git(['pull', '--ff-only', 'origin', baseBranch], cloneDir);
  git(['checkout', '-b', branch], cloneDir);

  const filename = `e2e-${runId}.md`;
  writeFileSync(join(cloneDir, filename), `# gh-delta e2e ${runId}\n`);
  git(['add', filename], cloneDir);
  git(['commit', '-m', `test: add playground artifact ${runId}`], cloneDir);
  git(['push', '-u', 'origin', branch], cloneDir);

  const created = gh([
    'pr',
    'create',
    '-R',
    repo,
    '--base',
    baseBranch,
    '--head',
    branch,
    '--title',
    `gh-delta e2e PR ${runId}`,
    '--body',
    `Created by gh-delta playground e2e run ${runId}.`,
  ]);
  return parseIssueOrPrNumber(created.stdout);
}

export async function main() {
  const runId = safeRunId(process.env.GH_DELTA_PLAYGROUND_RUN_ID ?? new Date().toISOString());
  const owner = gh(['api', 'user', '--jq', '.login']).stdout.trim();
  const explicitRepo = process.env.GH_DELTA_PLAYGROUND_REPO;
  const repoSpec = parseRepoSpec(explicitRepo ?? defaultPlaygroundRepoName(runId), owner);
  const repo = `${repoSpec.owner}/${repoSpec.name}`;
  const workRoot = join(DEFAULT_TMP_ROOT, runId);
  const cloneDir = join(workRoot, 'repo');
  const stateDir = process.env.GH_DELTA_PLAYGROUND_STATE_DIR ?? join(workRoot, 'state');
  const monitorId = `playground-${runId}`;
  const keepRepo = process.env.GH_DELTA_PLAYGROUND_KEEP_REPO === '1';
  let createdByHarness = false;

  mkdirSync(workRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    log(`run ${runId}`);
    createdByHarness = ensurePrivateRepo(repo);
    ensureLabels(repo);
    cloneRepo(repo, cloneDir);
    const baseBranch = ensureBaseCommit(cloneDir);

    const baseline = runDelta(repo, monitorId, stateDir);
    if (baseline.code !== 0 || baseline.report.baseline !== true) {
      throw new Error(`expected baseline exit 0; got ${baseline.code} ${baseline.report.summary}`);
    }
    log(`baseline: ${baseline.report.summary}`);

    const issueNumber = createIssue(repo, runId);
    expectDelta('issue create', repo, monitorId, stateDir, 'issue', issueNumber, 'new');

    gh([
      'issue',
      'comment',
      String(issueNumber),
      '-R',
      repo,
      '--body',
      `Comment from gh-delta playground e2e run ${runId}.`,
    ]);
    expectDelta('issue comment', repo, monitorId, stateDir, 'issue', issueNumber, 'new-comments');

    gh(['issue', 'edit', String(issueNumber), '-R', repo, '--add-label', E2E_LABEL_UPDATED]);
    expectDelta('issue relabel', repo, monitorId, stateDir, 'issue', issueNumber, 'relabeled');

    const prNumber = createPullRequest(repo, cloneDir, baseBranch, runId);
    expectDelta('pr create', repo, monitorId, stateDir, 'pr', prNumber, 'new');

    gh([
      'pr',
      'comment',
      String(prNumber),
      '-R',
      repo,
      '--body',
      `PR comment from gh-delta playground e2e run ${runId}.`,
    ]);
    expectDelta('pr comment', repo, monitorId, stateDir, 'pr', prNumber, 'new-comments');

    gh(['pr', 'merge', String(prNumber), '-R', repo, '--merge', '--delete-branch']);
    expectDelta('pr merge', repo, monitorId, stateDir, 'pr', prNumber, 'merged');

    log(`passed against ${repo}`);
    log(`state kept at ${stateDir}`);
    log(`clone kept at ${cloneDir}`);
  } finally {
    if (shouldDeletePlaygroundRepo({ createdByHarness, keepRepo })) {
      deleteRepo(repo);
    } else {
      log(`repo kept at ${repo}`);
    }
  }
}
