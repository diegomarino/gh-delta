// Text formatter tests: operator-facing output stays readable without a second bin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatListTextOutput,
  formatReadTextOutput,
  formatResetTextOutput,
  formatStatusTextOutput,
  formatTextOutput,
} from '../lib/text-output.mjs';
import { DELTA_CLASSES } from '../lib/contract.mjs';

const issueDelta = {
  entity: 'issue',
  number: 17,
  context: { title: 'Backfill customer imports' },
  classes: ['relabeled'],
};

const prDelta = {
  entity: 'pr',
  number: 42,
  context: { title: 'Add billing webhook' },
  classes: ['ci-changed', 'review-changed'],
};

// One repo's result row, as the enveloped report shape (lib/cli.mjs's
// buildDetectorReport) always carries it.
function result(overrides = {}) {
  return {
    repo: 'owner/repo',
    baseline: false,
    repoSource: 'flag',
    stateFile: '/tmp/state.json',
    rateLimit: null,
    ...overrides,
  };
}

test('baseline text output prints a heartbeat and baseline note', () => {
  const output = formatTextOutput({
    code: 0,
    report: {
      detectedAt: '2026-07-01T10:00:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [result({ baseline: true })],
      deltas: [],
      filteredDeltas: 0,
      summary: 'baseline established: 1 PRs, 2 issues',
    },
    now: () => '2026-07-01T10:00:00.000Z',
  });

  assert.match(output, /2026-07-01T10:00:00.000Z \| 0 delta\(s\)/);
  assert.match(output, /Baseline seeded for owner\/repo \(monitor: watch\)/);
});

test('text output makes suppressed attention-filter deltas visible to operators', () => {
  // Omitting this notice makes an exit-0 filtered run indistinguishable from a
  // no-change run even though the snapshot advanced past real changes.
  const output = formatTextOutput({
    code: 0,
    report: {
      detectedAt: '2026-07-01T10:00:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [result()],
      deltas: [],
      filteredDeltas: 2,
    },
    now: () => '2026-07-01T10:00:00.000Z',
  });

  assert.match(output, /Attention filters suppressed 2 delta\(s\)/);
  assert.match(output, /snapshot advanced and they will not be replayed/);
  assert.match(output, /No deltas remain after attention filtering/);
  assert.doesNotMatch(output, /No GitHub deltas since the last snapshot/);
});

test('delta text output prints each delta with suggested action', () => {
  const output = formatTextOutput({
    code: 10,
    report: {
      detectedAt: '2026-07-01T10:05:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [result()],
      filteredDeltas: 0,
      deltas: [
        prDelta,
        issueDelta,
        {
          entity: 'pr',
          number: 8,
          context: { title: null },
          classes: ['still-missing'],
        },
        {
          entity: 'pr',
          number: 9,
          context: { title: 'Refactor queue worker' },
          classes: ['unresolved-threads-added'],
        },
        {
          entity: 'issue',
          number: 21,
          context: { title: 'Webhook retries' },
          classes: ['reappeared'],
        },
        {
          entity: 'pr',
          number: 10,
          context: { title: null },
          classes: ['presumed-deleted'],
        },
        {
          entity: 'pr',
          number: 11,
          context: { title: 'Deploy backend v2' },
          classes: ['merged', 'ci-changed'],
        },
      ],
      summary: '7 delta(s)',
    },
    now: () => '2026-07-01T10:05:00.000Z',
  });

  assert.match(output, /2026-07-01T10:05:00.000Z \| 7 delta\(s\)/);
  assert.match(output, /PR #42 "Add billing webhook"/);
  assert.match(output, /suggested action: CI\/review changed/);
  assert.match(output, /ISSUE #17 "Backfill customer imports"/);
  assert.match(output, /suggested action: scope\/state changed/);
  assert.match(output, /PR #8 "\(no title\)"/);
  assert.match(output, /suggested action: object is still absent/);
  assert.match(output, /PR #9 "Refactor queue worker"/);
  assert.match(output, /suggested action: unresolved review threads/);
  assert.match(output, /ISSUE #21 "Webhook retries"/);
  assert.match(output, /suggested action: object returned to the fetch/);
  assert.match(output, /PR #10 "\(no title\)"/);
  assert.match(output, /suggested action: absent for several consecutive ticks/);
  assert.match(output, /PR #11 "Deploy backend v2"/);
  assert.match(output, /suggested action: item completed or closed/);
});

test('every contract delta class has a specific suggested action', () => {
  const fallback = 'inspect this delta and decide the next action.';
  for (const klass of DELTA_CLASSES) {
    const output = formatTextOutput({
      code: 10,
      report: {
        detectedAt: '2026-07-01T10:05:00.000Z',
        monitorId: 'watch',
        repos: ['owner/repo'],
        results: [result()],
        filteredDeltas: 0,
        deltas: [{ entity: 'pr', number: 1, context: { title: 't' }, classes: [klass] }],
      },
      now: () => '2026-07-01T10:05:00.000Z',
    });
    assert.doesNotMatch(
      output,
      new RegExp(`suggested action: ${fallback}`),
      `class "${klass}" falls back to the generic hint; add a SUGGESTIONS entry`,
    );
  }
});

test('review-comments-added and review-comments-removed have operator suggestions', () => {
  const render = (classes) =>
    formatTextOutput({
      code: 10,
      report: {
        detectedAt: '2026-07-01T10:05:00.000Z',
        monitorId: 'watch',
        repos: ['owner/repo'],
        results: [result()],
        filteredDeltas: 0,
        deltas: [{ entity: 'pr', number: 1, context: { title: 't' }, classes }],
      },
      now: () => '2026-07-01T10:05:00.000Z',
    });
  assert.match(render(['review-comments-added']), /review thread repl/i);
  assert.match(render(['review-comments-removed']), /review thread repl/i);
});

test('error text output reports snapshot-preserving failure', () => {
  const output = formatTextOutput({
    code: 1,
    report: {
      detectedAt: '2026-07-01T10:10:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [
        result({
          error: { kind: 'github', message: 'gh: API rate limit exceeded' },
        }),
      ],
      deltas: [],
      filteredDeltas: 0,
    },
    now: () => '2026-07-01T10:10:00.000Z',
  });

  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /gh: API rate limit exceeded/);
  assert.match(output, /Snapshot was not updated/);
  assert.match(output, /The next scheduled tick should retry/);
});

test('text output neutralizes terminal control sequences in GitHub-derived titles', () => {
  // An attacker who can open an issue/PR controls the title. A raw OSC/BEL could
  // rewrite the operator's terminal title, and an embedded newline could forge a
  // line that looks like a second, genuine delta. Both must be neutralized.
  const output = formatTextOutput({
    code: 10,
    report: {
      detectedAt: '2026-07-01T10:05:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [result()],
      filteredDeltas: 0,
      deltas: [
        {
          entity: 'pr',
          number: 1,
          context: { title: 'pwn\x1b]0;hijacked\x07\nowner/repo | 99 delta(s)' },
          classes: ['new'],
        },
      ],
    },
    now: () => '2026-07-01T10:05:00.000Z',
  });

  // Only the structural \n / \t the renderer adds itself may remain as controls.
  for (const ch of output) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      assert.ok(
        ch === '\n' || ch === '\t',
        `control byte 0x${code.toString(16)} leaked into text output`,
      );
    }
  }
  assert.ok(!output.includes('\x1b'), 'ESC must never reach the terminal');
  assert.ok(!output.includes('\x07'), 'BEL must never reach the terminal');

  // The attacker's newline must not forge a separate delta line: the crafted
  // "99 delta(s)" text collapses onto the same rendered label line as the title.
  const forged = output.split('\n').find((l) => l.includes('99 delta(s)'));
  assert.ok(
    forged.includes('pwn'),
    'the forged fragment must stay inside the sanitized title line',
  );
});

test('list text output prints the snapshot path so identical monitors are distinguishable', () => {
  const monitor = (stateFile) => ({
    repo: 'o/r',
    monitorId: 'watch',
    entities: ['pr', 'issue'],
    lastRun: '2026-07-01T09:00:00.000Z',
    prCount: 1,
    issueCount: 0,
    stateFile,
  });
  const output = formatListTextOutput({
    report: {
      command: 'list',
      at: '2026-07-01T10:00:00.000Z',
      stateDir: '/state',
      registryDir: null,
      since: null,
      skippedFiles: 0,
      monitors: [monitor('/state/a.json'), monitor('/state/b.json')],
    },
  });

  assert.match(output, /file: \/state\/a\.json/);
  assert.match(output, /file: \/state\/b\.json/);
  const monitorLines = output.split('\n').filter((l) => l.includes('o/r'));
  assert.notEqual(
    monitorLines[0],
    monitorLines[1],
    'monitors sharing repo + monitorId + entities must render as distinct lines',
  );
});

test('list text output identifies an economical watch snapshot scope', () => {
  const output = formatListTextOutput({
    report: {
      command: 'list',
      at: '2026-07-01T10:00:00.000Z',
      stateDir: '/state',
      registryDir: null,
      since: null,
      skippedFiles: 0,
      monitors: [
        {
          repo: 'o/r',
          monitorId: 'watch',
          entities: ['pr'],
          scope: 'watch-pr',
          lastRun: '2026-07-01T09:00:00.000Z',
          prCount: 1,
          issueCount: 0,
          stateFile: '/state/repo-o%2Fr__monitor-watch__watch-pr.json',
        },
      ],
    },
  });
  assert.match(output, /scope: watch-pr/);
});

test('list error text output avoids snapshot/delta vocabulary', () => {
  const output = formatListTextOutput({
    report: {
      command: 'list',
      error: '--since must be a positive integer followed by s, m, h, or d',
      kind: 'config',
      at: '2026-07-01T10:00:00.000Z',
    },
  });

  assert.match(output, /list error/);
  assert.match(output, /gh-delta list error: --since must be/);
  assert.doesNotMatch(output, /delta\(s\)/);
  assert.doesNotMatch(output, /[Ss]napshot/);
});

test('permanent error text output tells operator to fix before retrying', () => {
  const output = formatTextOutput({
    code: 2,
    report: {
      error: 'invalid snapshot JSON at /tmp/x.json',
      repo: 'owner/repo',
      monitorId: 'watch',
      at: '2026-07-01T10:10:00.000Z',
    },
    now: () => '2026-07-01T10:10:00.000Z',
  });

  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /invalid snapshot JSON/);
  assert.match(output, /Fix the configuration or snapshot; retrying will not help/);
});

test('single-repo repo-scoped error renders through the enveloped results[] row', () => {
  const output = formatTextOutput({
    code: 2,
    report: {
      detectedAt: '2026-07-01T10:10:00.000Z',
      monitorId: 'watch',
      repos: ['owner/repo'],
      results: [
        result({
          error: { kind: 'snapshot', message: 'invalid snapshot JSON', hint: 'run gh-delta reset' },
        }),
      ],
      deltas: [],
      filteredDeltas: 0,
    },
    now: () => '2026-07-01T10:10:00.000Z',
  });

  assert.match(output, /error \| 0 delta\(s\)/);
  assert.match(output, /invalid snapshot JSON/);
  assert.match(output, /hint: run gh-delta reset/);
  assert.match(output, /Fix the configuration or snapshot; retrying will not help/);
});

test('text error renderers retain structured recovery hints without altering successes', () => {
  const report = { at: '2026-01-01T00:00:00Z', error: 'bad input', hint: 'use --repo owner/name' };
  assert.match(
    formatTextOutput({ code: 2, report, now: () => report.at }),
    /hint: use --repo owner\/name/,
  );
  assert.match(formatListTextOutput({ report }), /hint: use --repo owner\/name/);
  assert.match(
    formatStatusTextOutput({ report, now: () => report.at }),
    /hint: use --repo owner\/name/,
  );
  assert.match(
    formatReadTextOutput({ code: 2, report, now: () => report.at }),
    /hint: use --repo owner\/name/,
  );
  const aggregate = formatTextOutput({
    code: 1,
    now: () => report.at,
    report: {
      detectedAt: report.at,
      monitorId: 'watch',
      repos: ['o/r', 'o/r2'],
      results: [
        result({ repo: 'o/r' }),
        result({ repo: 'o/r2', error: { kind: 'io', message: 'nope', hint: 'fix disk' } }),
      ],
      deltas: [],
      filteredDeltas: 0,
    },
  });
  assert.match(aggregate, /hint: fix disk/);
});

test('reset text output reports removed and absent target files', () => {
  const output = formatResetTextOutput({
    now: () => '2026-09-20T12:00:00.000Z',
    report: {
      at: '2026-09-20T12:00:00.000Z',
      summary: 'reset 3 file(s)',
      stateFile: '/tmp/state/poll.json',
      logFile: '/tmp/state/poll.ndjson',
      targets: [
        {
          scope: 'poll',
          stateFile: '/tmp/state/poll.json',
          logFile: '/tmp/state/poll.ndjson',
          removed: [],
          missing: ['/tmp/state/poll.json', '/tmp/state/poll.ndjson'],
        },
        {
          scope: 'watch-pr',
          stateFile: '/tmp/state/watch.json',
          logFile: '/tmp/state/watch.ndjson',
          removed: ['/tmp/state/watch.json', '/tmp/state/watch.ndjson'],
          missing: [],
        },
      ],
    },
  });

  assert.match(output, /poll: 0 removed, 2 absent/);
  assert.match(output, /watch-pr: 2 removed, 0 absent/);
});
