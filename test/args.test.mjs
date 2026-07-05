// Shared argument parser tests: both CLIs depend on this contract.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEntitySelection,
  validateMonitorId,
  validateRepo,
  canonicalEntityKey,
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
