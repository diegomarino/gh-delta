// Shared argument parser tests: both CLIs depend on this contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  parseEntitySelection,
  validateMonitorId,
  validateRepo,
  canonicalEntityKey,
  defaultMonitorId,
  parseEnrichmentSelection,
} from '../lib/args.mjs';

test('parseEntitySelection accepts pr, issue, or both and rejects empty selections', () => {
  assert.deepEqual(parseEntitySelection('pr,issue'), {
    wantsPr: true,
    wantsIssue: true,
    selected: ['pr', 'issue'],
    key: 'pr-issue',
    invalid: [],
    ok: true,
  });
  assert.deepEqual(parseEntitySelection('issue'), {
    wantsPr: false,
    wantsIssue: true,
    selected: ['issue'],
    key: 'issue',
    invalid: [],
    ok: true,
  });
  assert.deepEqual(parseEntitySelection('issue,pr'), {
    wantsPr: true,
    wantsIssue: true,
    selected: ['pr', 'issue'],
    key: 'pr-issue',
    invalid: [],
    ok: true,
  });
  assert.deepEqual(parseEntitySelection(''), {
    wantsPr: false,
    wantsIssue: false,
    selected: [],
    key: '',
    invalid: [],
    ok: false,
  });
});

test('validateRepo accepts owner/name and rejects malformed repo specs', () => {
  assert.deepEqual(validateRepo('owner/repo'), { ok: true, repo: 'owner/repo' });
  assert.deepEqual(validateRepo('owner/repo/extra').ok, false);
  assert.deepEqual(validateRepo('/repo').ok, false);
  assert.deepEqual(validateRepo('owner/').ok, false);
  assert.deepEqual(validateRepo('owner repo/name').ok, false);
});

test('validateMonitorId accepts stable safe ids and rejects path-like ids', () => {
  assert.deepEqual(validateMonitorId('prs-5m'), { ok: true, monitorId: 'prs-5m' });
  assert.deepEqual(validateMonitorId('team.prs_fast'), { ok: true, monitorId: 'team.prs_fast' });
  assert.deepEqual(validateMonitorId('').ok, false);
  assert.deepEqual(validateMonitorId('../state').ok, false);
  assert.deepEqual(validateMonitorId('with space').ok, false);
  assert.deepEqual(validateMonitorId('..').ok, false);
});

test('validateRepo canonicalizes to lowercase and rejects dot-only segments', () => {
  assert.deepEqual(validateRepo('Acme/App'), { ok: true, repo: 'acme/app' });
  assert.equal(validateRepo('../..').ok, false);
  assert.equal(validateRepo('./repo').ok, false);
  assert.equal(validateRepo('owner/..').ok, false);
});

test('canonicalEntityKey canonicalizes order, whitespace, and duplicates; unknown tokens pass through', () => {
  assert.equal(canonicalEntityKey('issue,pr'), 'pr-issue');
  assert.equal(canonicalEntityKey(' pr , pr '), 'pr');
  assert.equal(canonicalEntityKey('weird'), 'weird');
});

test('defaultMonitorId is stable within a worktree and scopes different worktrees separately', () => {
  const digest = (path) =>
    `host-${createHash('sha1').update(`box-a${path}`).digest('hex').slice(0, 12)}`;
  const resolveWorktree = (cwd) => (cwd.startsWith('/one/') ? '/one' : '/two');
  assert.equal(
    defaultMonitorId({ hostname: () => 'box-a', cwd: () => '/one/src/lib', resolveWorktree }),
    digest('/one'),
  );
  assert.equal(
    defaultMonitorId({ hostname: () => 'box-a', cwd: () => '/one/test', resolveWorktree }),
    digest('/one'),
  );
  assert.notEqual(
    defaultMonitorId({ hostname: () => 'box-a', cwd: () => '/one/src', resolveWorktree }),
    defaultMonitorId({ hostname: () => 'box-a', cwd: () => '/two/src', resolveWorktree }),
  );
});

test('defaultMonitorId falls back to the resolved cwd when git worktree lookup fails', () => {
  assert.equal(
    defaultMonitorId({
      hostname: () => 'box-a',
      cwd: () => '/outside/../outside/project',
      resolveWorktree: () => {
        throw new Error('not a git repository');
      },
    }),
    `host-${createHash('sha1').update('box-a/outside/project').digest('hex').slice(0, 12)}`,
  );
  assert.equal(
    validateMonitorId(defaultMonitorId({ hostname: () => 'x', resolveWorktree: () => '/repo' })).ok,
    true,
  );
});

test('parseEnrichmentSelection canonicalizes allowed kinds and rejects empty or unknown members', () => {
  assert.deepEqual(parseEnrichmentSelection('threads,review,threads'), {
    ok: true,
    kinds: ['review', 'threads'],
  });
  assert.equal(parseEnrichmentSelection('').ok, false);
  assert.equal(parseEnrichmentSelection('review,').ok, false);
  assert.equal(parseEnrichmentSelection('reviews').ok, false);
});

test('parseEnrichmentSelection accepts thread-replies', () => {
  const r = parseEnrichmentSelection('thread-replies');
  assert.deepEqual(r, { ok: true, kinds: ['thread-replies'] });
});

test('parseEnrichmentSelection canonicalizes thread-replies alongside the existing kinds', () => {
  const r = parseEnrichmentSelection('thread-replies,review');
  assert.deepEqual(r, { ok: true, kinds: ['review', 'thread-replies'] });
});
