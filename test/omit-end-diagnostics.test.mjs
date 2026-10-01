import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOmitEndDiagnostics } from '../lib/omit-end-diagnostics.mjs';

test('formatOmitEndDiagnostics orders errors, merges warning containers, and escapes controls', () => {
  const report = {
    error: 'nope',
    kind: 'config',
    hint: 'Fix the command configuration, or run gh-delta doctor for a local diagnostic.',
    warnings: [{ label: 'enrich', reason: 'request failed\nretry next tick' }],
  };
  const text = formatOmitEndDiagnostics(report, [
    { label: 'enrich', reason: 'request failed\nretry next tick' },
    { label: 'outpost', reason: 'later' },
  ]);
  assert.equal(
    text,
    [
      'gh-delta: error {"hint":"Fix the command configuration, or run gh-delta doctor for a local diagnostic.","kind":"config","message":"nope"}',
      'gh-delta: warning {"label":"enrich","reason":"request failed\\nretry next tick"}',
      'gh-delta: warning {"label":"outpost","reason":"later"}',
      '',
    ].join('\n'),
  );
  assert.equal(text.split('\n').filter(Boolean).length, 3);
  const del = formatOmitEndDiagnostics({
    warnings: [{ label: 'x', reason: 'A\u007F\u0085\u2028' }],
  });
  assert.match(del, /\\u007f\\u0085\\u2028/);
  assert.equal(del.includes('\u007F'), false);
  assert.equal(formatOmitEndDiagnostics({ deltas: [] }, []), '');
});

test('warning counts take the max across report and result containers', () => {
  const warning = { label: 'enrich', reason: 'once' };
  const text = formatOmitEndDiagnostics({ warnings: [warning] }, [
    warning,
    warning,
    { label: 'only-result', reason: 'r' },
  ]);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.filter((line) => line.includes('once')).length, 2);
  assert.equal(lines.at(-1).includes('only-result'), true);
});

test('warning merging preserves encounter order and appends unmatched result occurrences', () => {
  const a = { label: 'A', reason: 'a' };
  const b = { label: 'B', reason: 'b' };
  for (const [primary, secondary, expected] of [
    [[a, b, a], [], ['A', 'B', 'A']],
    [
      [a, b],
      [a, b, a],
      ['A', 'B', 'A'],
    ],
    [[], [a, b, a], ['A', 'B', 'A']],
    [
      [a, b, a],
      [b, a],
      ['A', 'B', 'A'],
    ],
  ]) {
    const text = formatOmitEndDiagnostics({ warnings: primary }, secondary);
    assert.deepEqual(
      text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line.slice('gh-delta: warning '.length)).label),
      expected,
    );
  }
});

test('diagnostics recursively sort numeric keys lexicographically and retain prototype-named fields', () => {
  const warning = JSON.parse(
    '{"reason":"r","label":"x","extra":[{"2":"two","10":"ten","__proto__":"keep","empty":"","nil":null}]}',
  );
  assert.equal(
    formatOmitEndDiagnostics({ warnings: [warning] }),
    'gh-delta: warning {"extra":[{"10":"ten","2":"two","__proto__":"keep","empty":"","nil":null}],"label":"x","reason":"r"}\n',
  );
  const distinct = JSON.parse(JSON.stringify(warning));
  distinct.extra[0].__proto__ = 'different';
  assert.equal(
    formatOmitEndDiagnostics({ warnings: [warning] }, [distinct])
      .trimEnd()
      .split('\n').length,
    2,
  );
});
