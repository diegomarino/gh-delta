// CLI contract tests: help, version, validation, format, repo derivation, and schema.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageJson, basePr, item, openFp, deps, baseDeps } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';
import { prFingerprint } from '../lib/fingerprint.mjs';

test('--state-dir derives a monitor-scoped snapshot path', () => {
  const d = deps([[basePr]]);
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'prs-fast', '--state-dir', '/tmp/state', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(d.readPath, '/tmp/state/repo-o%2Fr__monitor-prs-fast__pr.json');
  assert.equal(d.writePath, '/tmp/state/repo-o%2Fr__monitor-prs-fast__pr.json');
});

test('--help returns usage text without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help'], d);
  assert.equal(code, 0);
  assert.equal(typeof report, 'string');
  assert.ok(report.includes('Usage:'));
});

test('--help-json returns machine-readable help without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--help-json'], d);
  assert.equal(code, 0);
  assert.equal(typeof report, 'string');

  const help = JSON.parse(report);
  assert.equal(help.helpSchemaVersion, 1);
  assert.equal(help.command, 'gh-delta');
  assert.match(help.usage, /^gh-delta \[--repo/);
  assert.match(help.usage, /\[--summary-line\]/);
  assert.match(help.usage, /\[--detail\]/);
  assert.ok(help.options.some((option) => option.name === '--monitor-id'));
  assert.ok(help.options.some((option) => option.name === '--state-dir'));
  assert.ok(help.options.some((option) => option.name === '--format'));
  assert.ok(help.options.some((option) => option.name === '--summary-line'));
  assert.ok(help.options.some((option) => option.name === '--rate-limit-floor'));
  assert.match(help.output.description, /resetAt.*rate-limit/i);
  assert.ok(help.options.some((option) => option.name === '--help-json'));
  assert.ok(help.options.some((option) => option.name === '--version'));
  assert.equal(help.version, packageJson.version);
  assert.equal(help.options.find((option) => option.name === '--repo')?.required, false);
  assert.equal(help.options.find((option) => option.name === '--monitor-id')?.required, false);
  assert.match(help.exitCodes.find((entry) => entry.code === 10)?.meaning ?? '', /Deltas found/);
  assert.deepEqual(help.output.formats, ['json', 'text', 'compact', 'ndjson', 'template']);
  assert.deepEqual(help.stateConcurrency, {
    sameStateFile: 'locked: one writer at a time, others exit busy (1)',
    overlapRisk:
      'the pre-write fence narrows, but cannot fully close, a lost-update window to a scheduler gap between the fence check and the snapshot rename',
    corruptionRisk: 'atomic writes prevent partial JSON snapshots',
  });
  assert.ok(help.options.some((option) => option.name === '--lock-stale-ms'));
});

test('--version returns package version, npm channel, and release URL without fetching GitHub', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(['--version'], d);
  assert.equal(code, 0);
  assert.equal(
    report,
    `gh-delta ${packageJson.version} (npm) https://github.com/diegomarino/gh-delta/releases\n`,
  );
});

test('missing --repo returns code 2 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => ({ status: 'declined' }),
  };
  const { code, report } = run(['--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.match(report.error, /--repo/);
});

test('missing --monitor-id defaults to a stable per-machine host id', () => {
  const d = deps([[]]);
  const { code, report } = run(['--repo', 'o/r'], d);
  assert.equal(code, 0);
  assert.match(report.monitorId, /^host-[0-9a-f]{12}$/);
  assert.ok(d.readPath.includes(`__monitor-${report.monitorId}__`));
  const again = deps([[]]);
  const { report: report2 } = run(['--repo', 'o/r'], again);
  assert.equal(report2.monitorId, report.monitorId); // stable across invocations
});

test('monitor id precedence is flag then environment then the generated default', () => {
  // Each `env` here replaces `d.env` wholesale, overriding the module-level
  // GH_DELTA_NO_REGISTRY guard above -- re-include it explicitly so this
  // resolved detector tick doesn't write a real breadcrumb into the
  // developer's ~/.local/state/gh-delta/registry.
  for (const [argv, env, expected] of [
    [['--monitor-id', 'flag'], { GH_DELTA_MONITOR_ID: 'env', GH_DELTA_NO_REGISTRY: '1' }, 'flag'],
    [[], { GH_DELTA_MONITOR_ID: 'env', GH_DELTA_NO_REGISTRY: '1' }, 'env'],
    [[], { GH_DELTA_NO_REGISTRY: '1' }, 'generated'],
  ]) {
    const d = deps([[]]);
    d.env = env;
    d.defaultMonitor = () => 'generated';
    const result = run(['--repo', 'o/r', '--state-file', '/tmp/x.json', ...argv], d);
    assert.equal(result.code, 0);
    assert.equal(result.report.monitorId, expected);
  }
  const invalid = deps([[]]);
  invalid.env = { GH_DELTA_MONITOR_ID: '../bad' };
  assert.equal(run(['--repo', 'o/r', '--state-file', '/tmp/x.json'], invalid).code, 2);
});

test('--state-file and --state-dir are mutually exclusive', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--state-dir', '/tmp'],
    d,
  );
  assert.equal(code, 2);
  assert.match(report.error, /mutually exclusive/);
});

test('missing state flags default to a per-user tmpdir-derived snapshot', () => {
  const d = deps([[]]);
  const { code, report } = run(['--repo', 'o/r', '--monitor-id', 'main'], d);
  assert.equal(code, 0);
  assert.ok(d.readPath.startsWith(join(tmpdir(), 'gh-delta-')), d.readPath);
  assert.ok(d.readPath.endsWith(`${'/'}repo-o%2Fr__monitor-main__pr-issue.json`));
  assert.equal(report.results[0].stateFile, d.readPath);
  assert.equal(report.results[0].baseline, true);
});

test('explicit state flags still resolve verbatim and populate report.stateFile', () => {
  const d = deps([[]]);
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(report.results[0].stateFile, '/tmp/x.json');
  const d2 = deps([[]]);
  const { report: report2 } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-dir', '/tmp/state', '--entities', 'pr'],
    d2,
  );
  assert.equal(report2.results[0].stateFile, '/tmp/state/repo-o%2Fr__monitor-main__pr.json');
});

test('invalid --entities returns code 2 before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--entities',
      'release',
    ],
    d,
  );
  assert.equal(code, 2);
  assert.match(report.error, /--entities/);
});

test('unknown arguments return structured code 2 error', () => {
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--bogus'],
    {
      fetchPRs: () => {
        throw new Error('should not fetch');
      },
      fetchIssues: () => {
        throw new Error('should not fetch');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.match(report.error, /Unknown option|--bogus/);
});

test('invalid repo and monitor id fail before fetching', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
  };

  assert.equal(
    run(['--repo', 'owner/repo/extra', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d)
      .code,
    2,
  );
  assert.equal(
    run(['--repo', 'owner/repo', '--monitor-id', '../bad', '--state-file', '/tmp/x.json'], d).code,
    2,
  );
});

test('--format text prints operator output from the main gh-delta binary', async () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });

  const { code, output } = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'text'],
    d,
  );

  assert.equal(code, 10);
  assert.match(output, /2026-07-01T12:00:00Z \| 1 delta\(s\)/);
  assert.match(output, /PR #42 "add widget": merged/);
  assert.match(output, /suggested action: item completed or closed/);
  assert.doesNotMatch(output, /"deltas"/);
});

test('--format json prints the detector report JSON from the main gh-delta binary', async () => {
  const d = deps([[basePr]]);

  const { code, output } = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'json'],
    d,
  );

  assert.equal(code, 0);
  const report = JSON.parse(output);
  assert.equal(report.monitorId, 'main');
  assert.equal(report.results[0].baseline, true);
});

test('duplicate --format flags use the same last-value rule for parsing and rendering', async () => {
  const d = deps([[]]);
  const textThenJson = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--format',
      'text',
      '--format',
      'json',
    ],
    d,
  );
  assert.equal(JSON.parse(textThenJson.output).results[0].baseline, true);

  const d2 = deps([[]]);
  const jsonThenText = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--format',
      'json',
      '--format',
      'text',
    ],
    d2,
  );
  assert.match(jsonThenText.output, /Baseline seeded/);
});

test('--help-json usage includes detail flags and documents entities grammar', () => {
  const { report } = run(['--help-json'], { now: () => '2026-07-01T12:00:00Z' });
  const help = JSON.parse(report);
  assert.match(help.usage, /\[--summary-line\]/);
  assert.match(help.usage, /\[--detail\]/);
  assert.ok(help.options.some((option) => option.name === '--summary-line'));
  assert.ok(help.output.deltaFields.includes('summaryLine'));
  assert.equal(help.output.deltaFields.includes('line'), false);
  assert.ok(help.output.deltaFields.includes('context'));
  assert.ok(help.output.deltaFields.includes('changed'));
  assert.ok(help.output.deltaFields.includes('details'));
  assert.ok(help.output.deltaDetailFields.includes('opaque'));
  assert.deepEqual(help.output.deltaDetailFieldsByClass['new-comments'], ['conversationComments']);
  assert.deepEqual(help.output.deltaDetailFieldsByClass.relabeled, ['labels']);
  const entities = help.options.find((option) => option.name === '--entities');
  assert.equal(
    entities.grammar,
    'comma-separated unique values from: pr, issue; input order is canonicalized',
  );
});

test('--help wins over unknown flags and invalid outpost URLs', () => {
  const d = { now: () => '2026-07-01T12:00:00Z' };
  const helpWithBogus = run(['--help', '--bogus'], d);
  assert.equal(helpWithBogus.code, 0);
  assert.ok(helpWithBogus.report.includes('Usage:'));
  const helpWithBadOutpost = run(['--help', '--outpost-url', 'not-a-url'], d);
  assert.equal(helpWithBadOutpost.code, 0);
  const helpJsonWins = run(['--help-json', '--repo'], d);
  assert.equal(helpJsonWins.code, 0);
  assert.equal(JSON.parse(helpJsonWins.report).helpSchemaVersion, 1);
});

test('explicit --repo never calls resolveRepo and reports repoSource:flag', () => {
  let called = false;
  const res = run(
    ['--repo', 'owner/repo', '--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => {
        called = true;
        return { status: 'declined' };
      },
    }),
  );
  assert.equal(called, false);
  assert.equal(res.report.results[0].repoSource, 'flag');
  assert.equal(res.report.results[0].repo, 'owner/repo');
});

test('absent --repo uses the derived repo and its source', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'Acme/Proj',
        source: 'git-remote',
        warnings: [],
      }),
    }),
  );
  assert.equal(res.report.results[0].repo, 'acme/proj'); // validateRepo lowercased it
  assert.equal(res.report.results[0].repoSource, 'git-remote');
});

test('derivation declined -> config error, exit 2', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({ resolveRepo: () => ({ status: 'declined' }) }),
  );
  assert.equal(res.code, 2);
  assert.equal(res.report.kind, 'config');
  assert.match(res.report.error, /could not derive/);
});

test('derivation failed transiently -> github error, exit 1', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({ resolveRepo: () => ({ status: 'failed', reason: 'timed out after 60000ms' }) }),
  );
  assert.equal(res.code, 1);
  assert.equal(res.report.kind, 'github');
});

test('divergence warning from derivation rides on the run result', () => {
  const res = run(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0].reason, /acme\/proj/);
});

test('derivation divergence warning appears in JSON report.warnings', async () => {
  const out = await runCommand(
    ['--state-file', '/tmp/x.json', '--no-registry'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  const report = JSON.parse(out.output);
  assert.ok(report.warnings?.some((w) => /acme\/proj/.test(w.reason)));
});

test('derivation divergence warning appears in text output', async () => {
  const out = await runCommand(
    ['--state-file', '/tmp/x.json', '--no-registry', '--format', 'text'],
    baseDeps({
      resolveRepo: () => ({
        status: 'found',
        repo: 'me/fork',
        source: 'git-remote',
        warnings: [
          {
            label: 'repo',
            reason:
              'monitoring origin (me/fork); upstream resolves to a different repo (acme/proj) — pass --repo to choose explicitly',
          },
        ],
      }),
    }),
  );
  assert.match(out.output, /acme\/proj/);
});

test('schema subcommand is local-only and emits a newline-terminated schema', async () => {
  let touched = false;
  const result = await runCommand(['schema', '--format', 'compact'], {
    now: () => '2026-09-20T00:00:00Z',
    fetchPRs: () => {
      touched = true;
      return [];
    },
    readSnapshot: () => {
      touched = true;
      return null;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(touched, false);
  assert.equal(JSON.parse(result.output).title, 'compact report');
  assert.ok(result.output.endsWith('\n'));
});

test('schema rejects an unknown format as configuration error', () => {
  const result = run(['schema', '--format', 'text'], { now: () => '2026-09-20T00:00:00Z' });
  assert.equal(result.code, 2);
  assert.match(result.report.error, /json, compact, or ndjson/);
});

test('single-repo compact output carries per-delta repo and context from the report', async () => {
  const before = { ...basePr, updatedAt: '2026-07-01T10:00:00Z' };
  const after = { ...basePr, updatedAt: '2026-07-01T11:00:00Z', state: 'closed' };
  const d = deps([[after]], { existing: { pr: { 42: item(prFingerprint(before)) }, issue: {} } });
  const result = await runCommand(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--format', 'compact'],
    d,
  );
  const report = JSON.parse(result.output);
  assert.equal(report.deltas[0].repo, 'o/r');
  assert.equal(report.deltas[0].context.title, 'add widget');
  assert.equal(Object.hasOwn(report.deltas[0], 'url'), false);
});
