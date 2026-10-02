// CLI contract tests: watch --until cleanup, terminal markers, and entry locks.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basePr, item, RATE_LIMIT, deps } from './helpers/cli-fixtures.mjs';
import { run } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';
import { addWatch } from '../lib/watch.mjs';
import { writeTerminalIgnoredLocked } from '../lib/watch-lock.mjs';

test('watch cleanup failure warns after snapshot publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-cleanup-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  writeFileSync(
    join(watch, 'pr-42.json'),
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  d.removeWatchUnchanged = () => {
    throw new Error('unlink denied');
  };
  const { code, warnings } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.ok(
    warnings.some(
      (warning) => warning.label === 'watch cleanup' && /unlink denied/.test(warning.reason),
    ),
  );
});

test('ignored merged terminal delta keeps its watch entry while snapshot advances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-ignore-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  let cleanup = false;
  d.removeWatchUnchanged = () => {
    cleanup = true;
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(code, 0);
  assert.deepEqual(report.deltas, []);
  assert.equal(report.filteredDeltas, 1);
  assert.equal(d.writes, 1);
  assert.equal(cleanup, false);
  assert.ok(readFileSync(entry, 'utf8'));
});

test('--until closed watch entry is cleaned up when the PR merges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-until-closed-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"closed","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.equal(existsSync(entry), false);
});

test('--until merged keeps its watch entry when the PR closes without merging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-until-merged-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const d = deps([[{ ...basePr, state: 'closed', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'closed', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.equal(existsSync(entry), true);

  const ls = run(['watch', 'ls', '--watch-dir', watch], d);
  assert.equal(ls.code, 0);
  assert.deepEqual(ls.report.entries, [
    { entity: 'pr', number: 42, until: 'merged', addedAt: '2026-07-01T00:00:00.000Z' },
  ]);
});

// A PR that merges AND relabels in the same tick still carries `to.state ===
// 'merged'` even after `--ignore-classes merged` strips the `merged` class
// (attention filtering only touches `delta.classes`, never the compared
// fingerprint -- see applyAttentionFilters). The cleanup loop must key off a
// SURVIVING terminal class, not the raw unfiltered state, or an operator's
// explicit --ignore-classes is silently overridden and monitoring ends anyway.
test('--ignore-classes merged protects a --until merged watch entry even when the PR also merges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-ignore-merged-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const mergedAndRelabeled = {
    ...basePr,
    state: 'merged',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'shipped' }],
  };
  const d = deps([[mergedAndRelabeled]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [mergedAndRelabeled], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), true, 'the watch entry must survive: merged was ignored');
});

// Same tick, no --ignore-classes: the merged class survives filtering (there
// is no filtering), so cleanup must still fire -- guards against
// over-correcting the fix above into never cleaning up a relabeled merge.
test('the same merge-and-relabel tick without --ignore-classes still cleans up the watch entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-merged-relabeled-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const mergedAndRelabeled = {
    ...basePr,
    state: 'merged',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'shipped' }],
  };
  const d = deps([[mergedAndRelabeled]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [mergedAndRelabeled], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes.sort(), ['merged', 'relabeled'].sort());
  assert.equal(existsSync(entry), false);
});

// diffEntity's `new`/`first-seen` path never combines its class with
// `merged`/`closed` (see lib/detect.mjs: `classes: [fp.state === 'open' ?
// 'new' : 'first-seen']` is always a bare one-element array) -- a watched PR
// absent from the snapshot but already terminal on its first observation
// (e.g. it merges between `watch add` and the first poll) can NEVER carry a
// surviving transition class, with or without any filter in play. Requiring
// one, as the previous round did, stranded the watch entry forever: the
// snapshot records the terminal fingerprint, so no later tick fires any
// delta at all for it. `first-seen`/`baseline-state`/`new` are OBSERVATION
// classes (delta.firstObserved === true) -- "first time seeing this item" --
// which says nothing about a transition an attention filter could mean to
// protect, unlike a real `merged`/`closed` transition class, which
// classifyPr/classifyIssue only ever attach when an actual state change was
// observed (see the `if (oldFp.state !== fp.state)` guard there).
test('a watched PR absent from the snapshot but already merged on first observation is cleaned up (no leaked watch entry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-first-seen-merged-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const alreadyMerged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  // PR 42 is absent from the existing snapshot's pr map (present but empty),
  // so this is NOT a baseline run -- diffEntity takes the first-seen path.
  const d = deps([[alreadyMerged]], { existing: { pr: {}, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [alreadyMerged], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['first-seen']);
  assert.equal(report.deltas[0].firstObserved, true);
  assert.equal(existsSync(entry), false, 'the watch entry must not be stranded forever');
});

// The `--until closed` equivalent of the above: a watched PR absent from the
// snapshot but already closed (not merged) on first observation.
test('a watched PR absent from the snapshot but already closed on first observation is cleaned up under --until closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-first-seen-closed-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"closed","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const alreadyClosed = { ...basePr, state: 'closed', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[alreadyClosed]], { existing: { pr: {}, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [alreadyClosed], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['first-seen']);
  assert.equal(existsSync(entry), false);
});

// A first-seen delta is an observation, not a transition -- an attention
// filter targeting it is a report-shaping preference, never a "do not clean
// up" instruction the way `--ignore-classes merged` legitimately is for a
// real transition (see the two tests above this block). Filtering
// `first-seen` itself drops the WHOLE delta before the cleanup loop ever
// sees it (applyAttentionFilters discards a delta once every class is
// stripped), so cleanup does not fire on this tick either way -- this test
// pins that this is a report-visibility side effect, not a silent
// resurrection of the fixed leak, and is a pre-existing characteristic of
// "attention filtering also gates which deltas the cleanup loop ever sees"
// that predates all three rounds on this predicate (see the note in the
// commit message about it being out of scope here).
test('--ignore-classes first-seen drops the delta entirely, so cleanup does not fire this tick either', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-ignore-first-seen-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const alreadyMerged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[alreadyMerged]], { existing: { pr: {}, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [alreadyMerged], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'first-seen',
    ],
    d,
  );
  assert.equal(code, 0);
  assert.deepEqual(report.deltas, []);
  assert.equal(existsSync(entry), true);
});

// `baseline-state` (--baseline-emit-state) can never be terminal by
// construction: baselineStateDeltas filters to `d.to.fingerprint.state ===
// 'open'` only (lib/detect.mjs), so there is no reachable watch-cleanup
// scenario to test end-to-end for it -- this pins that structural invariant
// directly instead of asserting a real-code-path scenario that cannot occur.
test('baseline-emit-state deltas can never carry a terminal state (structural invariant backing the observation-class reasoning)', () => {
  const d = deps([[{ ...basePr, state: 'merged' }]]);
  const { report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/gd-baseline-state-terminal.json',
      '--baseline-emit-state',
    ],
    d,
  );
  assert.deepEqual(report.deltas, [], 'a terminal item is silently seeded, never baseline-state');
});

// The remaining gap in the space: broad polling (forced here by an issue
// watch entry, per lib/cli.mjs's economicalWatch -- any non-PR entry falls
// back to full fetching) can already hold an already-terminal item in its
// snapshot from BEFORE the watch was added. A later metadata-only change
// (e.g. a relabel) fires a delta whose ONLY class is `relabeled` --
// classifyPr never re-adds `merged`/`closed` because `from.state` already
// equals `to.state` (no state transition this tick) -- while `firstObserved`
// is absent (the item was already known). Neither of the previous two
// rounds' conditions fires, so cleanup must key off `from.state` already
// being terminal: there was no transition THIS tick for any attention
// filter to have meant "ignore" about.
test('an already-terminal item with only a metadata-only delta (broad polling) is still cleaned up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-already-terminal-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const prEntry = join(watch, 'pr-42.json');
  writeFileSync(
    prEntry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  // An issue watch entry forces broad polling (economicalWatch requires
  // every watched entry to be a PR) -- irrelevant to this PR's own cleanup,
  // present only to exercise the broad-polling path the finding names.
  writeFileSync(
    join(watch, 'issue-1.json'),
    '{"entity":"issue","number":1,"until":"closed","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const alreadyMergedFp = prFingerprint({ ...basePr, state: 'merged' });
  const relabeledStillMerged = {
    ...basePr,
    state: 'merged',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'shipped' }],
  };
  const d = deps([[relabeledStillMerged]], {
    existing: { pr: { 42: item(alreadyMergedFp) }, issue: {} },
  });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', state, '--watch-dir', watch],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['relabeled']);
  assert.equal(report.deltas[0].firstObserved, undefined);
  assert.equal(existsSync(prEntry), false, 'an already-terminal item must not strand its entry');
});

// The round-7 defect: classifyPr classifies by DESTINATION state only
// (`if (oldFp.state !== fp.state) { if (fp.state === 'merged') ... }`), not
// by requiring the prior state to be open. A PR observed `closed`, then
// reopened and merged between polls, still emits `merged` -- a genuine
// transition -- even though `from.state` was already terminal (`closed`).
// The round-6 predicate wrongly treated ANY terminal from.state as "no
// transition happened", silently skipping the marker for this exact case.
test('a PR observed closed, then reopened and merged between polls, under --ignore-classes merged with a surviving class: marked and kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-closed-to-merged-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const previouslyClosedFp = prFingerprint({ ...basePr, state: 'closed' });
  const mergedAndRelabeled = {
    ...basePr,
    state: 'merged',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'shipped' }],
  };
  const d = deps([[mergedAndRelabeled]], {
    existing: { pr: { 42: item(previouslyClosedFp) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [mergedAndRelabeled], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), true, 'closed -> merged is a real transition; it must be marked');
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'the closed -> merged transition must be recorded as ignored',
  );
});

test('a PR observed closed, then reopened and merged with the delta ENTIRELY dropped by the filter: marked and kept on a later tick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-closed-to-merged-dropped-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const previouslyClosedFp = prFingerprint({ ...basePr, state: 'closed' });
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const mergedRelabeled = { ...merged, updatedAt: '2026-07-01T12:00:00Z', labels: [{ name: 'a' }] };
  const rowSeq = [[merged], [mergedRelabeled]];
  const d = deps([[]], { existing: { pr: { 42: item(previouslyClosedFp) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: rowSeq.shift(), rateLimit: RATE_LIMIT });
  const argvWith = () => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    state,
    '--watch-dir',
    watch,
    '--ignore-classes',
    'merged',
  ];

  // Tick 1: the closed -> merged transition, its only class `merged`, fully
  // dropped by the filter (nothing else survives).
  const tick1 = run(argvWith(), d);
  assert.equal(tick1.code, 0);
  assert.deepEqual(tick1.report.deltas, []);
  assert.equal(existsSync(entry), true);
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'a fully dropped closed -> merged transition must still be marked',
  );

  // Tick 2: a later, unrelated metadata-only delta under the SAME filter --
  // the mark recorded on tick 1 must protect it.
  const tick2 = run(argvWith(), d);
  assert.equal(tick2.code, 10);
  assert.deepEqual(tick2.report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), true, 'the mark must protect the entry on the later tick');
});

// The hole reported in the fourth round on this predicate: 'already-terminal
// from.state implies eligible' (the fix above) cannot by itself distinguish
// "terminal before the watch existed" from "terminal transition ignored
// while watched" -- both look identical in the CURRENT tick's data. Closing
// it needs new persisted state: lib/watch.mjs's `ignoredTerminalAt`,
// written the moment a genuine transition's terminal class is filtered
// (see lib/cli.mjs's watchedTerminalTransitionFilteredThisTick), and
// checked against the CURRENT invocation's filters on every later tick
// (isTerminalCleanupEligible) so the entry stays protected for as long as
// -- and only as long as -- the same filter keeps applying.
test('--ignore-classes merged protects a --until merged entry across multiple subsequent ticks, until the filter is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-ignored-sticky-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const mergedRelabeledA = {
    ...merged,
    updatedAt: '2026-07-01T12:00:00Z',
    labels: [{ name: 'a' }],
  };
  const mergedRelabeledB = {
    ...merged,
    updatedAt: '2026-07-01T13:00:00Z',
    labels: [{ name: 'b' }],
  };
  const rowSeq = [[merged], [mergedRelabeledA], [mergedRelabeledB]];
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: rowSeq.shift(), rateLimit: RATE_LIMIT });
  const argvWith = (extra = []) => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    state,
    '--watch-dir',
    watch,
    ...extra,
  ];

  // Tick 1: the merge itself, under --ignore-classes merged. Its ONLY class
  // is `merged`, so filtering drops the WHOLE delta -- an empty report, but
  // the entry must survive AND get marked (this is the moment that trace
  // would otherwise be lost forever).
  const tick1 = run(argvWith(['--ignore-classes', 'merged']), d);
  assert.equal(tick1.code, 0);
  assert.deepEqual(tick1.report.deltas, []);
  assert.equal(existsSync(entry), true, 'the filtered merge itself must not strand the entry');
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'the merge tick must durably record that its transition was ignored',
  );

  // Tick 2: an unrelated metadata-only delta, SAME filter still active. This
  // is the reported hole: from.state is already 'merged', and the surviving
  // delta carries no `merged` class at all (the state did not change again)
  // -- without the recorded mark, this would have silently cleaned up.
  const tick2 = run(argvWith(['--ignore-classes', 'merged']), d);
  assert.equal(tick2.code, 10);
  assert.deepEqual(tick2.report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), true, 'protection must survive a second, unrelated tick');

  // Tick 3: the filter is DROPPED. The mark no longer protects anything --
  // cleanup fires on the very next delta, whatever its class.
  const tick3 = run(argvWith(), d);
  assert.equal(tick3.code, 10);
  assert.deepEqual(tick3.report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), false, 'dropping the filter must clean up on the next tick');
});

// The ordering defect: markTerminalIgnored ran AFTER the snapshot publish
// and its failure was reduced to a warning. A filtered terminal transition
// is unrepeatable -- once the snapshot advances to the terminal state, no
// later tick will ever see the transition again -- so publishing anyway
// permanently strands the entry into the exact premature-cleanup bug the
// marker exists to prevent. The fix: the marker write now runs BEFORE
// publication, and a failure there fails the WHOLE tick (same class as an
// unwritable state directory or a lost lock, already failing ticks a few
// lines up), so the snapshot never advances past a filtered transition
// without the marker that protects it.
test('a marker write failure fails the tick instead of publishing an unmarked terminal snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-mark-write-fails-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const mergedRelabeled = {
    ...merged,
    updatedAt: '2026-07-01T12:00:00Z',
    labels: [{ name: 'a' }],
  };
  const rowSeq = [[merged], [merged], [mergedRelabeled]];
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: rowSeq.shift(), rateLimit: RATE_LIMIT });
  const argvWith = (extra = []) => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    state,
    '--watch-dir',
    watch,
    '--ignore-classes',
    'merged',
    ...extra,
  ];

  // Tick 1: the merge, filtered, but the marker write is made to fail.
  d.writeTerminalIgnoredLocked = () => {
    throw new Error('EACCES: permission denied');
  };
  const tick1 = run(argvWith(), d);
  assert.equal(tick1.code, 1);
  assert.equal(tick1.report.results[0].error.kind, 'io');
  assert.equal(d.writes, 0, 'the snapshot must NOT advance past an unmarked filtered transition');
  assert.equal(existsSync(entry), true);
  assert.equal(JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt, undefined);

  // Tick 2: a real retry (marker writes work again). The snapshot never
  // advanced, so the SAME transition is observed again from scratch, and
  // this time it is correctly marked and published together.
  delete d.writeTerminalIgnoredLocked;
  const tick2 = run(argvWith(), d);
  assert.equal(tick2.code, 0);
  assert.equal(d.writes, 1);
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'the retried tick must record the marker this time',
  );

  // Tick 3: a later, unrelated metadata-only delta under the SAME filter --
  // the marker recorded on the successful retry must still protect it.
  const tick3 = run(argvWith(), d);
  assert.equal(tick3.code, 10);
  assert.deepEqual(tick3.report.deltas[0].classes, ['relabeled']);
  assert.equal(
    existsSync(entry),
    true,
    'the marker recorded on retry must protect the entry, not just the failed attempt',
  );
});

// The concurrency defect: `watch add`/`rm` never touch the state-file lock
// this tick holds throughout -- only the per-entry lock, a genuinely
// separate resource (see the code comment above the marker-write block).
// A concurrent `watch add` replacing this entry mid-tick is therefore real,
// not theoretical. Case 1: the replacement lands BEFORE the mark call reads
// the file, so markTerminalIgnored's own byte comparison correctly returns
// false -- previously silently ignored. The tick must fail rather than
// publish a terminal snapshot for a transition nothing now protects.
test('a watch entry replaced concurrently just before it is marked fails the tick, not silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-race-before-mark-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [merged], rateLimit: RATE_LIMIT });
  // Simulate a concurrent `watch add pr:42 --until closed` landing between
  // watchFiles being read at tick start and the mark write itself: the real
  // writeTerminalIgnoredLocked, called against the ORIGINAL (now stale)
  // bytes, correctly observes the mismatch and returns false. (This
  // replacement is written directly, bypassing the entry's own lock, to
  // isolate what the byte comparison alone catches -- see the later test
  // for the lock itself refusing a real, lock-respecting `watch add`.)
  d.writeTerminalIgnoredLocked = (path, bytes, ignoredAt) => {
    writeFileSync(
      path,
      '{"entity":"pr","number":42,"until":"closed","addedAt":"2026-07-01T00:05:00.000Z"}\n',
    );
    return writeTerminalIgnoredLocked(path, bytes, ignoredAt);
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.equal(code, 1);
  assert.equal(report.results[0].error.kind, 'busy');
  assert.equal(d.writes, 0, 'the snapshot must not advance past an unmarked filtered transition');
  // The concurrent replacement itself is untouched -- our own write never
  // even attempted to clobber it (markTerminalIgnored's own compare fenced
  // that off).
  assert.equal(JSON.parse(readFileSync(entry, 'utf8')).until, 'closed');
});

// Round 9: every prior round moved a CHECK (verify the mark survived,
// re-verify immediately before publication) without ever holding a lock
// across both the mark and the snapshot publish -- so a replacement landing
// in the gap between "mark succeeded" and "snapshot committed" always found
// a fresh window to land in. This test exercises the actual interleaving
// across that boundary, not just a before-the-fact detection: a REAL,
// lock-respecting `addWatch` call attempted WHILE the tick is inside its
// mark-and-publish critical section must fail fast ("watch entry locked"),
// proving the entry's lock is genuinely held for the whole span, not
// released between the two writes. The tick itself, unaware its entry lock
// was contended for a moment, completes normally.
test('a real concurrent watch add attempted during mark-and-publish fails fast, proving the lock spans both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-lock-spans-publish-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [merged], rateLimit: RATE_LIMIT });
  let concurrentAddThrew = null;
  d.writeTerminalIgnoredLocked = (path, bytes, ignoredAt) => {
    const marked = writeTerminalIgnoredLocked(path, bytes, ignoredAt);
    // We are still INSIDE withTerminalMarkLocks' held lock here (the mark
    // write and the eventual snapshot publish both happen inside its
    // callback) -- a real `watch add` attempting to touch this exact entry
    // right now must be refused, not silently interleaved.
    try {
      addWatch(watch, 'pr:42', 'closed');
    } catch (err) {
      concurrentAddThrew = err;
    }
    return marked;
  };
  const { code } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
    ],
    d,
  );
  assert.match(String(concurrentAddThrew?.message), /watch directory locked/);
  // The tick itself is unaffected by the OTHER process's failed attempt --
  // its own hold on the lock, not the contender's, is what mattered.
  assert.equal(code, 0);
  assert.equal(
    d.writes,
    1,
    'the snapshot must still publish normally for the tick that holds the lock',
  );
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'the entry must be marked and untouched by the failed concurrent add',
  );
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).until,
    'merged',
    'the concurrent add must not have landed at all',
  );
});

// Round 10: the entry lock's lease must not be tied to --gh-timeout-ms, a
// NETWORK timeout with nothing to do with the disk write it now protects.
// Run with a --gh-timeout-ms tiny enough that the OLD (round 9) coupling
// would have given the entry lock only a ~6-second lease; confirm the
// lease actually granted, inspected mid-critical-section, still reflects
// withTerminalMarkLocks' own fixed ENTRY_LOCK_LEASE_MS default (round 12
// decoupled this from --lock-stale-ms too, see the test right after this
// one) -- end to end, through the real CLI flags, not just the
// lib/watch.mjs unit test.
test('a tiny --gh-timeout-ms does not shrink the entry lock lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-lease-integration-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [merged], rateLimit: RATE_LIMIT });
  let impliedLeaseMs;
  const before = Date.now();
  d.writeTerminalIgnoredLocked = (path, bytes, ignoredAt) => {
    const marked = writeTerminalIgnoredLocked(path, bytes, ignoredAt);
    const lock = JSON.parse(readFileSync(`${path}.lock`, 'utf8'));
    impliedLeaseMs = Date.parse(lock.expiresAt) - before;
    return marked;
  };
  const { code } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
      // A --gh-timeout-ms this small would give the entry lock only a
      // ~6-second lease under the round-9 coupling (--gh-timeout-ms +
      // lib/lock.mjs's 5s slack) -- far too short to survive any real
      // snapshot write under load.
      '--gh-timeout-ms',
      '100',
    ],
    d,
  );
  assert.equal(code, 0);
  // The lease must reflect withTerminalMarkLocks' own fixed default, not the
  // 100ms/6-second network timeout.
  assert.ok(
    impliedLeaseMs > 500000,
    `expected the entry lock lease to reflect its own fixed default, not --gh-timeout-ms's 100ms; got ${impliedLeaseMs}ms`,
  );
});

// Round 12: this is the actual regression -- round 11 reused --lock-stale-ms
// for this lease, but lib/help.mjs and docs/contract.md both document that
// flag as governing only an UNREADABLE/corrupt lock, never a readable lock's
// expiresAt. An operator has every reason to set it small (it's documented
// as a corrupt-lock detection ceiling) with nothing telling them that doing
// so also shortens this unrelated critical section. Run with a
// --lock-stale-ms tiny enough that the round-11 coupling would have given
// the entry lock only a ~6-second lease; confirm the lease actually granted
// still reflects the fixed internal default instead.
test('a tiny --lock-stale-ms does not shrink the entry lock lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-lease-integration-lsm-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: [merged], rateLimit: RATE_LIMIT });
  let impliedLeaseMs;
  const before = Date.now();
  d.writeTerminalIgnoredLocked = (path, bytes, ignoredAt) => {
    const marked = writeTerminalIgnoredLocked(path, bytes, ignoredAt);
    const lock = JSON.parse(readFileSync(`${path}.lock`, 'utf8'));
    impliedLeaseMs = Date.parse(lock.expiresAt) - before;
    return marked;
  };
  const { code } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--ignore-classes',
      'merged',
      // A --lock-stale-ms this small would give the entry lock only a
      // ~6-second lease under the round-11 coupling (--lock-stale-ms +
      // lib/lock.mjs's 5s slack) -- far too short to survive any real
      // snapshot write under load.
      '--lock-stale-ms',
      '1s',
    ],
    d,
  );
  assert.equal(code, 0);
  assert.ok(
    impliedLeaseMs > 500000,
    `expected the entry lock lease to reflect its own fixed default, not --lock-stale-ms's 1s; got ${impliedLeaseMs}ms`,
  );
});

// The granularity defect: --only-classes is a DELTA-level gate (a delta
// survives WHOLE once ANY named class matches, all its other classes
// intact -- see lib/help.mjs's own description), unlike --ignore-classes'
// CLASS-level removal. merged+relabeled under --only-classes relabeled
// therefore survives WITH `merged` still present -- there is no
// suppression to record, and cleanup must fire normally. An earlier version
// treated `merged` as suppressed merely because --only-classes was active
// and did not itself name `merged`, writing a spurious marker; the marked
// (but still-eligible) delta then hit removeWatchUnchanged with bytes this
// same tick's own spurious write had already made stale, silently
// stranding the entry forever.
test('--only-classes relabeled genuinely keeps a merged+relabeled delta WHOLE: no spurious marker, cleanup fires normally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-only-classes-kept-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const mergedAndRelabeled = {
    ...basePr,
    state: 'merged',
    updatedAt: '2026-07-01T11:00:00Z',
    labels: [{ name: 'shipped' }],
  };
  const d = deps([[mergedAndRelabeled]], {
    existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} },
  });
  d.fetchPRsByNumber = () => ({ rows: [mergedAndRelabeled], rateLimit: RATE_LIMIT });
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      state,
      '--watch-dir',
      watch,
      '--only-classes',
      'relabeled',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes.sort(), ['merged', 'relabeled'].sort());
  // The definitive proof: if a spurious marker HAD been written this tick,
  // removeWatchUnchanged's compare would fail against the now-stale bytes
  // its own write caused, and the entry would survive. It must not.
  assert.equal(existsSync(entry), false, 'a delta that genuinely kept merged must still clean up');
});

test('--only-classes relabeled genuinely rejecting a bare merge writes the marker and protects the entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-only-classes-rejected-'));
  const state = join(dir, 'state.json');
  const watch = join(dir, 'watch');
  mkdirSync(watch);
  const entry = join(watch, 'pr-42.json');
  writeFileSync(
    entry,
    '{"entity":"pr","number":42,"until":"merged","addedAt":"2026-07-01T00:00:00.000Z"}\n',
  );
  const merged = { ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' };
  const mergedRelabeled = {
    ...merged,
    updatedAt: '2026-07-01T12:00:00Z',
    labels: [{ name: 'a' }],
  };
  const rowSeq = [[merged], [mergedRelabeled]];
  const d = deps([[]], { existing: { pr: { 42: item(prFingerprint(basePr)) }, issue: {} } });
  d.fetchPRsByNumber = () => ({ rows: rowSeq.shift(), rateLimit: RATE_LIMIT });
  const argvWith = () => [
    '--repo',
    'o/r',
    '--monitor-id',
    'main',
    '--state-file',
    state,
    '--watch-dir',
    watch,
    '--only-classes',
    'relabeled',
  ];

  // Tick 1: a BARE merge (no relabel). Its only class, `merged`, does not
  // match --only-classes relabeled at all, so the whole delta is genuinely
  // rejected -- exactly what --only-classes' own delta-level gate means.
  const tick1 = run(argvWith(), d);
  assert.equal(tick1.code, 0);
  assert.deepEqual(tick1.report.deltas, []);
  assert.equal(existsSync(entry), true);
  assert.equal(
    JSON.parse(readFileSync(entry, 'utf8')).ignoredTerminalAt !== undefined,
    true,
    'a genuinely rejected transition must still be marked',
  );

  // Tick 2: a later, unrelated metadata-only delta -- now `relabeled` alone
  // matches --only-classes relabeled and survives, but the recorded mark
  // must still protect the entry (state.merged, no fresh merged class here).
  const tick2 = run(argvWith(), d);
  assert.equal(tick2.code, 10);
  assert.deepEqual(tick2.report.deltas[0].classes, ['relabeled']);
  assert.equal(existsSync(entry), true, 'the marker must protect across a later matching tick');
});
