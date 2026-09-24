// Deterministic source-checkout demo runner. It never contacts GitHub: each
// mode injects the observation boundary and keeps all state below a fresh tmpdir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';
import { setCursorAtomic } from '../lib/deltalog.mjs';

const mode = process.argv[2];
const stateDir = mkdtempSync(join(tmpdir(), 'gh-delta-example-'));
const base = {
  number: 42,
  title: 'Demo pull request',
  state: 'open',
  updatedAt: '2026-09-21T08:00:00.000Z',
  isDraft: false,
  checks: [{ name: 'CI', kind: 'check', status: 'completed', conclusion: 'success' }],
  reviewDecision: 'review_required',
  reviews: [],
  mergeable: 'mergeable',
  comments: 0,
  headSha: 'demo-sha',
};
const changed = {
  ...base,
  updatedAt: '2026-09-21T08:01:00.000Z',
  checks: [{ name: 'CI', kind: 'check', status: 'completed', conclusion: 'failure' }],
};
const demoRateLimit = { cost: 1, remaining: 4999, resetAt: '2026-09-21T09:00:00.000Z' };
const detector = (observation) =>
  run(
    [
      '--repo',
      'diegomarino/gh-delta-demo',
      '--state-dir',
      stateDir,
      '--entities',
      'pr',
      '--summaries',
    ],
    {
      fetchPRs: () => ({ rows: observation, rateLimit: demoRateLimit }),
      fetchIssues: () => ({ rows: [], rateLimit: demoRateLimit }),
      now: () => '2026-09-21T08:00:00.000Z',
    },
  );

try {
  if (mode === 'agent-worker-wait') {
    const result = await runCommand(
      [
        'wait',
        '--repo',
        'diegomarino/gh-delta-demo',
        '--state-dir',
        stateDir,
        '--entities',
        'pr',
        '--timeout',
        '1m',
        '--until-summary',
        'ciRollup=green',
      ],
      {
        fetchPRs: () => ({ rows: [base], rateLimit: demoRateLimit }),
        fetchIssues: () => ({ rows: [], rateLimit: demoRateLimit }),
        now: () => '2026-09-21T08:00:00.000Z',
      },
    );
    if (result.code !== 10 || result.report.reason !== 'already-satisfied')
      throw new Error('wait demo did not satisfy CI');
    console.log(
      JSON.stringify({ reason: result.report.reason, action: 'inspect PR before merge' }),
    );
  } else if (mode === 'coordinator-fanout') {
    detector([base]);
    const tick = run(
      [
        '--repo',
        'diegomarino/gh-delta-demo',
        '--state-dir',
        stateDir,
        '--entities',
        'pr',
        '--summaries',
        '--log',
      ],
      {
        fetchPRs: () => ({ rows: [changed], rateLimit: demoRateLimit }),
        fetchIssues: () => ({ rows: [], rateLimit: demoRateLimit }),
        now: () => '2026-09-21T08:01:00.000Z',
      },
    );
    const logFile = tick.report.results?.[0]?.logFile;
    if (tick.code !== 10 || !logFile) throw new Error('coordinator did not append a delta log');
    for (const worker of ['reviewer', 'notifier', 'triage']) {
      const cursor = join(stateDir, `${worker}.cursor.json`);
      setCursorAtomic(cursor, { cursorVersion: 1, logFile, seq: 0 });
      const read = await runCommand(['read', '--cursor', cursor, '--number', '42'], {});
      if (read.code !== 10) throw new Error(`${worker} did not receive the delta`);
    }
    console.log(JSON.stringify({ workers: 3, logFile }));
  } else if (mode === 'claude-code-hook' || mode === 'github-action') {
    detector([base]);
    const result = detector([changed]);
    if (result.code !== 10) throw new Error('demo hook/action expected a delta');
    console.log(JSON.stringify({ changed: true, deltas: result.report.deltas.length }));
  } else throw new Error(`unknown example mode: ${mode}`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
