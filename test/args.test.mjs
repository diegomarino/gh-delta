import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEntitySelection, parseOutpostArgs } from '../lib/args.mjs';

test('parseOutpostArgs strips a separate outpost URL flag and preserves detector args', () => {
  assert.deepEqual(
    parseOutpostArgs([
      '--repo',
      'owner/repo',
      '--outpost-url',
      'https://example.com/hook',
      '--state-file',
      'state.json',
    ]),
    {
      detectorArgs: ['--repo', 'owner/repo', '--state-file', 'state.json'],
      outpostUrl: 'https://example.com/hook',
    },
  );
});

test('parseEntitySelection accepts pr, issue, or both and rejects empty selections', () => {
  assert.deepEqual(parseEntitySelection('pr,issue'), {
    wantsPr: true,
    wantsIssue: true,
    invalid: [],
    ok: true,
  });
  assert.deepEqual(parseEntitySelection('issue'), {
    wantsPr: false,
    wantsIssue: true,
    invalid: [],
    ok: true,
  });
  assert.deepEqual(parseEntitySelection(''), {
    wantsPr: false,
    wantsIssue: false,
    invalid: [],
    ok: false,
  });
});
