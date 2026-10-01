import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchSync } from '../lib/watch-sync-parse.mjs';

test('parseWatchSync accepts a framed set and rejects truncation and empty sets', () => {
  const parsed = parseWatchSync(
    [
      '# comment',
      '',
      'pr:3 until=merged repo=acme/widgets thread=t-0004 package=F001-P05',
      'issue:9 until=closed repo=acme/widgets',
      'end 2',
      '# tail',
    ].join('\n'),
  );
  assert.deepEqual(parsed.entries[0].labels, { package: 'F001-P05', thread: 't-0004' });
  assert.equal(parsed.entries[1].entity, 'issue');
  assert.equal(Object.hasOwn(parsed.entries[1], 'labels'), false);
  const crlf = parseWatchSync('pr:3 until=merged\r\nend 1\r\n', { repo: 'acme/widgets' });
  assert.equal(crlf.entries[0].repo, 'acme/widgets');
  assert.throws(() => parseWatchSync('pr:3 until=merged\n'), /watch sync/);
  assert.throws(() => parseWatchSync('end 0\n'), /allow-empty/);
  assert.deepEqual(parseWatchSync('end 0\n', { allowEmpty: true }).entries, []);
  assert.throws(
    () => parseWatchSync('pr:03 until=merged\npr:3 until=merged\nend 2\n'),
    /watch sync/,
  );
  assert.throws(
    () => parseWatchSync('pr:3 until=merged\npr:3 until=merged repo=acme/widgets\nend 2\n'),
    /watch sync/,
  );
  assert.throws(() => parseWatchSync('pr:3 until=merged thread=\nend 1\n'), /watch sync/);
});
