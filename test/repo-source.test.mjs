// test/repo-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyForge, parseRemoteUrl, resolveRepoFromGit } from '../lib/repo-source.mjs';

test('identifyForge matches github.com case-insensitively, nothing else', () => {
  assert.equal(identifyForge('github.com')?.id, 'github');
  assert.equal(identifyForge('GitHub.com')?.id, 'github');
  assert.equal(identifyForge('gitlab.com'), null);
  assert.equal(identifyForge('github.example.com'), null); // Enterprise -> gh fallback, not here
});

test('parseRemoteUrl handles the common URL shapes', () => {
  const want = { host: 'github.com', owner: 'owner', name: 'repo' };
  assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo.git'), want);
  assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo'), want);
  assert.deepEqual(parseRemoteUrl('https://github.com/owner/repo.git'), want);
  assert.deepEqual(parseRemoteUrl('https://github.com/owner/repo/'), want);
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com/owner/repo.git'), want);
});

test('parseRemoteUrl uses hostname, not host, so ports do not break matching', () => {
  // Regression for the /codex:adversarial-review [high] finding.
  assert.deepEqual(parseRemoteUrl('ssh://github.com:2222/owner/repo'), {
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
  });
  assert.deepEqual(parseRemoteUrl('https://github.com:8443/owner/repo'), {
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
  });
});

test('parseRemoteUrl strips embedded credentials from the host', () => {
  assert.deepEqual(parseRemoteUrl('https://user:token@github.com/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
  });
});

test('parseRemoteUrl declines anything that is not exactly two path segments', () => {
  assert.equal(parseRemoteUrl('https://github.com/owner'), null); // 1 segment
  assert.equal(parseRemoteUrl('https://github.com/group/sub/repo'), null); // 3 segments
  assert.equal(parseRemoteUrl('not a url'), null);
  assert.equal(parseRemoteUrl(''), null);
});

// Fake exec: map `${cmd} ${args.join(' ')}` -> string to return, Error to throw.
const fakeExec = (table) => (cmd, args) => {
  const key = `${cmd} ${args.join(' ')}`;
  if (!(key in table)) throw new Error(`unexpected exec: ${key}`);
  const v = table[key];
  if (v instanceof Error) throw v;
  return v;
};
const timeoutErr = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
const noRemote = () => new Error('fatal: No such remote');

test('origin on github.com resolves to git-remote source', () => {
  const exec = fakeExec({
    'git remote get-url origin': 'git@github.com:Owner/Repo.git',
    'git remote get-url upstream': noRemote(),
  });
  assert.deepEqual(resolveRepoFromGit({ exec }), {
    status: 'found',
    repo: 'Owner/Repo',
    source: 'git-remote',
    warnings: [],
  });
});

test('origin absent falls back to upstream', () => {
  const exec = fakeExec({
    'git remote get-url origin': noRemote(),
    'git remote get-url upstream': 'https://github.com/acme/proj.git',
  });
  assert.deepEqual(resolveRepoFromGit({ exec }), {
    status: 'found',
    repo: 'acme/proj',
    source: 'git-remote',
    warnings: [],
  });
});

test('origin and upstream diverge -> origin wins, warning emitted', () => {
  const exec = fakeExec({
    'git remote get-url origin': 'git@github.com:me/fork.git',
    'git remote get-url upstream': 'git@github.com:acme/proj.git',
  });
  const r = resolveRepoFromGit({ exec });
  assert.equal(r.repo, 'me/fork');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].label, 'repo');
  assert.match(r.warnings[0].reason, /me\/fork/);
  assert.match(r.warnings[0].reason, /acme\/proj/);
});

test('non-github origin declines git parsing and falls to gh', () => {
  const exec = fakeExec({
    'git remote get-url origin': 'git@gitlab.com:me/proj.git',
    'git remote get-url upstream': noRemote(),
    'gh repo view --json nameWithOwner -q .nameWithOwner': 'ent/proj\n',
  });
  assert.deepEqual(resolveRepoFromGit({ exec }), {
    status: 'found',
    repo: 'ent/proj',
    source: 'gh',
    warnings: [],
  });
});

test('no git remotes and gh says not-a-repo -> declined', () => {
  const exec = fakeExec({
    'git remote get-url origin': noRemote(),
    'git remote get-url upstream': noRemote(),
    'gh repo view --json nameWithOwner -q .nameWithOwner': new Error('no repo'),
  });
  assert.deepEqual(resolveRepoFromGit({ exec }), { status: 'declined' });
});

test('gh timeout during fallback -> failed, not declined', () => {
  const exec = fakeExec({
    'git remote get-url origin': noRemote(),
    'git remote get-url upstream': noRemote(),
    'gh repo view --json nameWithOwner -q .nameWithOwner': timeoutErr(),
  });
  assert.equal(resolveRepoFromGit({ exec }).status, 'failed');
});

test('gh fallback receives the configured ghTimeoutMs', () => {
  let seen;
  const exec = (cmd, args, opts) => {
    if (cmd === 'git') throw noRemote();
    seen = opts?.timeoutMs;
    return 'ent/proj';
  };
  resolveRepoFromGit({ exec, ghTimeoutMs: 12345 });
  assert.equal(seen, 12345);
});

test('a credentialed declined URL never leaks into the result', () => {
  const exec = fakeExec({
    'git remote get-url origin': 'https://user:s3cr3t@gitlab.com/me/proj.git',
    'git remote get-url upstream': noRemote(),
    'gh repo view --json nameWithOwner -q .nameWithOwner': new Error('no repo'),
  });
  assert.deepEqual(resolveRepoFromGit({ exec }), { status: 'declined' });
  // (no warnings/reason string exists here to carry the token)
});
