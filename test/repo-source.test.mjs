// test/repo-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyForge, parseRemoteUrl } from '../lib/repo-source.mjs';

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
  assert.deepEqual(parseRemoteUrl('ssh://github.com:2222/owner/repo'),
    { host: 'github.com', owner: 'owner', name: 'repo' });
  assert.deepEqual(parseRemoteUrl('https://github.com:8443/owner/repo'),
    { host: 'github.com', owner: 'owner', name: 'repo' });
});

test('parseRemoteUrl strips embedded credentials from the host', () => {
  assert.deepEqual(parseRemoteUrl('https://user:token@github.com/owner/repo.git'),
    { host: 'github.com', owner: 'owner', name: 'repo' });
});

test('parseRemoteUrl declines anything that is not exactly two path segments', () => {
  assert.equal(parseRemoteUrl('https://github.com/owner'), null);           // 1 segment
  assert.equal(parseRemoteUrl('https://github.com/group/sub/repo'), null);  // 3 segments
  assert.equal(parseRemoteUrl('not a url'), null);
  assert.equal(parseRemoteUrl(''), null);
});
