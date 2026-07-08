// CLI contract tests: exit codes, snapshot safety, and user-facing detail output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCommand } from '../lib/cli.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const basePr = {
  number: 42,
  title: 'add widget',
  state: 'OPEN',
  updatedAt: '2026-07-01T10:00:00Z',
  isDraft: false,
  statusCheckRollup: [],
  reviewDecision: 'REVIEW_REQUIRED',
  latestReviews: [],
  mergeable: 'UNKNOWN',
  comments: [],
  headRefOid: 'sha1',
};

function deps(prSeq, { existing = null } = {}) {
  let writes = 0;
  let stored = existing;
  let readPath;
  let writePath;
  return {
    fetchPRs: () => prSeq.shift(),
    fetchIssues: () => [],
    readSnapshot: (p) => {
      readPath = p;
      return stored;
    },
    writeSnapshotAtomic: (p, d) => {
      writes++;
      writePath = p;
      stored = d;
    },
    now: () => '2026-07-01T12:00:00Z',
    get writes() {
      return writes;
    },
    get stored() {
      return stored;
    },
    get readPath() {
      return readPath;
    },
    get writePath() {
      return writePath;
    },
  };
}

test('first run returns code 0 (baseline) and writes the snapshot', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.baseline, true);
  assert.equal(report.monitorId, 'main');
  assert.deepEqual(report.entities, ['pr', 'issue']);
  assert.equal(d.writes, 1);
});

test('error reports carry schemaVersion and omit deltas', () => {
  const d = deps([[basePr]]);
  const { code, report } = run(['--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 2);
  assert.equal(report.schemaVersion, 1);
  assert.match(report.error, /--repo/);
  assert.equal(report.deltas, undefined);
  assert.equal(d.writes, 0);
});

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

test('a delta returns code 10 and rewrites the snapshot', () => {
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          commentsOverflow: false,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(code, 10);
  assert.ok(report.deltas.some((x) => x.classes.includes('merged')));
});

test('no change returns code 0 and still refreshes snapshot', () => {
  const seed = { pr: {}, issue: {} };
  const d = deps([[]], { existing: seed });
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
});

test('a gh failure returns code 1 and does NOT write the snapshot', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => [],
    readSnapshot: () => ({ pr: {}, issue: {} }),
    writeSnapshotAtomic: () => {
      throw new Error('should not be called');
    },
    now: () => '2026-07-01T12:00:00Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 1);
});

test('--summary-line attaches only the human summary line to each delta', () => {
  const d = deps([[{ ...basePr, totalCommentsCount: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'x',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--summary-line'],
    d,
  );
  assert.equal(report.deltas[0].summaryLine, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(report.deltas[0].line, undefined);
  assert.equal(report.deltas[0].details, undefined);
});

test('--detail keeps line compatibility and adds structured class details', () => {
  const d = deps([[{ ...basePr, totalCommentsCount: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'x',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--detail'],
    d,
  );
  const delta = report.deltas[0];
  assert.equal(delta.line, 'PR #42 "add widget": ci-changed, new-comments');
  assert.equal(delta.summaryLine, delta.line);
  assert.deepEqual(delta.details, [
    {
      class: 'ci-changed',
      field: 'ci',
      from: 'x',
      to: 'da39a3ee5e6b',
      opaque: true,
    },
    {
      class: 'new-comments',
      field: 'comments',
      from: 0,
      to: 2,
      delta: 2,
    },
  ]);
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
  assert.match(help.usage, /^gh-delta --repo/);
  assert.match(help.usage, /\[--summary-line\]/);
  assert.match(help.usage, /\[--detail\]/);
  assert.ok(help.options.some((option) => option.name === '--monitor-id'));
  assert.ok(help.options.some((option) => option.name === '--state-dir'));
  assert.ok(help.options.some((option) => option.name === '--format'));
  assert.ok(help.options.some((option) => option.name === '--summary-line'));
  assert.ok(help.options.some((option) => option.name === '--help-json'));
  assert.ok(help.options.some((option) => option.name === '--version'));
  assert.equal(help.version, packageJson.version);
  assert.equal(help.options.find((option) => option.name === '--repo')?.required, true);
  assert.equal(help.options.find((option) => option.name === '--monitor-id')?.required, false);
  assert.match(help.exitCodes.find((entry) => entry.code === 10)?.meaning ?? '', /Deltas found/);
  assert.deepEqual(help.output.formats, ['json', 'text']);
  assert.deepEqual(help.stateConcurrency, {
    sameStateFile: 'serialize',
    overlapRisk: 'duplicate delta emission; last writer wins',
    corruptionRisk: 'atomic writes prevent partial JSON snapshots',
  });
});

test('--version returns package version without fetching GitHub', () => {
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
  assert.equal(report, `gh-delta ${packageJson.version}\n`);
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
  assert.equal(report.stateFile, d.readPath);
  assert.equal(report.baseline, true);
});

test('explicit state flags still resolve verbatim and populate report.stateFile', () => {
  const d = deps([[]]);
  const { report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    d,
  );
  assert.equal(report.stateFile, '/tmp/x.json');
  const d2 = deps([[]]);
  const { report: report2 } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-dir', '/tmp/state', '--entities', 'pr'],
    d2,
  );
  assert.equal(report2.stateFile, '/tmp/state/repo-o%2Fr__monitor-main__pr.json');
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

test('--entities pr preserves existing issue snapshot entries', () => {
  const existing = {
    pr: {
      42: {
        state: 'OPEN',
        updatedAt: '2026-07-01T10:00:00Z',
        isDraft: false,
        ci: 'da39a3ee5e6b',
        review: 'REVIEW_REQUIRED',
        reviews: 'da39a3ee5e6b',
        mergeable: 'UNKNOWN',
        comments: 0,
        head: 'sha1',
      },
    },
    issue: { 7: { state: 'OPEN', updatedAt: '2026-07-01T10:00:00Z', labels: [], comments: 0 } },
  };
  const d = deps([[basePr]], { existing });
  const { code } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    d,
  );
  assert.equal(code, 0);
  assert.ok(d.stored.issue['7']);
});

test('corrupt snapshot read failure returns code 2 and does NOT write', () => {
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      fetchPRs: () => [basePr],
      fetchIssues: () => [],
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(writes, 0);
  assert.match(report.error, /invalid snapshot JSON/);
});

test('invalid snapshot horizon returns code 2 before fetching', () => {
  let fetched = false;
  let writes = 0;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'],
    {
      fetchPRs: () => {
        fetched = true;
        return [];
      },
      fetchIssues: () => [],
      readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: 'not-a-date' } }),
      writeSnapshotAtomic: () => {
        writes++;
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'snapshot');
  assert.match(report.error, /invalid snapshot horizon/);
  assert.equal(fetched, false);
  assert.equal(writes, 0);
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

test('existing snapshot is read before GitHub fetches', () => {
  let read = false;
  let fetched = false;
  const { code, report } = run(
    ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json', '--entities', 'pr'],
    {
      fetchPRs: () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      fetchIssues: () => {
        throw new Error('should not fetch');
      },
      readSnapshot: () => {
        read = true;
        throw new Error('invalid snapshot JSON at /tmp/x.json');
      },
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(read, true);
  assert.equal(fetched, false);
  assert.match(report.error, /invalid snapshot/);
});

test('gh-delta sends outpost payloads with monitor id after the snapshot write', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          commentsOverflow: false,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 202 };
  };

  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    d,
  );

  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://example.com/gh-delta');
  assert.equal(posts[0].body.type, 'gh-delta.delta');
  assert.equal(posts[0].body.monitorId, 'main');
  assert.equal(posts[0].body.branch, undefined);
  assert.equal(posts[0].body.eventId, 'gh-delta.delta.v1:o/r:main:pr:42:merged');
  assert.equal(
    posts[0].body.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:merged:2026-07-01T12:00:00Z',
  );
});

test('--format text prints operator output from the main gh-delta binary', async () => {
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          commentsOverflow: false,
          head: 'sha1',
        },
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
  assert.equal(report.baseline, true);
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
  assert.equal(JSON.parse(textThenJson.output).baseline, true);

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
  assert.ok(help.output.deltaFields.includes('line'));
  assert.ok(help.output.deltaFields.includes('details'));
  assert.ok(help.output.deltaDetailFields.includes('opaque'));
  assert.deepEqual(help.output.deltaDetailFieldsByClass['new-comments'], ['comments']);
  assert.deepEqual(help.output.deltaDetailFieldsByClass.relabeled, ['labels']);
  const entities = help.options.find((option) => option.name === '--entities');
  assert.equal(
    entities.grammar,
    'comma-separated unique values from: pr, issue; input order is canonicalized',
  );
});

test('gh-delta rejects invalid --outpost-url before fetching GitHub', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  let fetches = 0;
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'file:///tmp/outpost.json',
    ],
    {
      fetchPRs: () => {
        fetches++;
        throw new Error('should not fetch');
      },
      fetchIssues: () => [],
      readSnapshot: () => ({ pr: {}, issue: {} }),
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(fetches, 0);
  assert.match(report.error, /--outpost-url must use http: or https:/);
});

test('outpost eventId is order-independent across class permutations', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const report = { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' };
  const a = buildOutpostPayload({
    report,
    delta: { entity: 'pr', number: 42, title: 'x', classes: ['review-changed', 'ci-changed'] },
  });
  const b = buildOutpostPayload({
    report,
    delta: { entity: 'pr', number: 42, title: 'x', classes: ['ci-changed', 'review-changed'] },
  });
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.deliveryId, b.deliveryId);
  assert.equal(a.eventId, 'gh-delta.delta.v1:o/r:main:pr:42:ci-changed+review-changed');
  assert.equal(
    a.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:ci-changed+review-changed:2026-07-01T12:00:00Z',
  );
});

test('outpost eventId is stable across detector timestamps while deliveryId changes', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = { entity: 'pr', number: 42, title: 'x', classes: ['merged'] };
  const first = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:00Z' },
    delta,
  });
  const second = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', at: '2026-07-01T12:00:01Z' },
    delta,
  });

  assert.equal(first.eventId, second.eventId);
  assert.notEqual(first.deliveryId, second.deliveryId);
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

test('duplicate --outpost-url uses last-wins like every other flag', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[]]);
  const posts = [];
  d.outpostFetch = async (url) => {
    posts.push(url);
    return { ok: true, status: 202 };
  };
  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://first.example',
      '--outpost-url',
      'https://second.example',
    ],
    d,
  );
  assert.equal(code, 0); // baseline, no posts — but parsing must not error
});

test('error kinds map to exit codes: config/snapshot=2, github/io=1', () => {
  const base = ['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'];
  const noFetch = { now: () => '2026-07-01T12:00:00Z' };
  const config = run(
    ['--repo', 'o/r', '--monitor-id', '../bad', '--state-file', '/tmp/x.json'],
    noFetch,
  );
  assert.equal(config.code, 2);
  assert.equal(config.report.kind, 'config');
  const snapshot = run(base, {
    ...noFetch,
    readSnapshot: () => {
      throw new Error('invalid snapshot JSON at /tmp/x.json');
    },
  });
  assert.equal(snapshot.code, 2);
  assert.equal(snapshot.report.kind, 'snapshot');
  const github = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => {
      throw new Error('gh: rate limited');
    },
    fetchIssues: () => [],
  });
  assert.equal(github.code, 1);
  assert.equal(github.report.kind, 'github');
  const io = run(base, {
    ...noFetch,
    readSnapshot: () => null,
    fetchPRs: () => [],
    fetchIssues: () => [],
    writeSnapshotAtomic: () => {
      throw new Error('ENOSPC');
    },
  });
  assert.equal(io.code, 1);
  assert.equal(io.report.kind, 'io');
});

test('sendOutposts stops after the configured max payload count', async () => {
  const { sendOutposts } = await import('../lib/outpost.mjs');
  const report = {
    repo: 'o/r',
    monitorId: 'main',
    at: '2026-07-01T12:00:00Z',
    deltas: [
      { entity: 'pr', number: 1, title: 'one', classes: ['new'] },
      { entity: 'pr', number: 2, title: 'two', classes: ['new'] },
    ],
  };
  const posts = [];
  const { warnings } = await sendOutposts({
    outpostUrl: 'https://example.com',
    report,
    maxPosts: 1,
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    },
  });

  assert.equal(posts.length, 1);
  assert.deepEqual(warnings, [
    { label: 'outpost', reason: 'skipped 1 delta(s) after max outpost post count 1' },
  ]);
});

test('outpost warnings land inside the JSON report, not on stderr', async () => {
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  d.outpostFetch = async () => ({ ok: false, status: 500 });
  const { code, output, stderr } = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(stderr, '');
  const report = JSON.parse(output);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0].reason, /HTTP 500/);
});

test('--outpost-max-posts caps delivery from the CLI', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const existing = { pr: {}, issue: {} };
  const d = deps([[basePr, { ...basePr, number: 43, title: 'second' }]], { existing });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, warnings } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
      '--outpost-max-posts',
      '1',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(posts.length, 1);
  assert.match(warnings[0].reason, /skipped 1 delta/);
});

test('--gh-timeout-ms abc is a config error (exit 2, kind config)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      'abc',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--gh-timeout-ms/);
});

test('--gh-timeout-ms threads into fetchers and defaults to 60000', () => {
  let receivedTimeoutMs;
  const makeDeps = () => ({
    fetchPRs: (_repo, opts) => {
      receivedTimeoutMs = opts.timeoutMs;
      return [];
    },
    fetchIssues: () => [],
    readSnapshot: () => null,
    writeSnapshotAtomic: () => {},
    now: () => '2026-07-01T12:00:00Z',
  });

  run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], makeDeps());
  assert.equal(receivedTimeoutMs, 60000);

  run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--gh-timeout-ms',
      '5000',
    ],
    makeDeps(),
  );
  assert.equal(receivedTimeoutMs, 5000);
});

test('non-numeric outpost flags are config errors (exit 2)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-timeout-ms',
      'soon',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-timeout-ms/);
});

test('the CLI threads the snapshot horizon into fetchers and stamps a new one', () => {
  let receivedCutoff = 'unset';
  const d = {
    fetchPRs: (_repo, opts) => {
      receivedCutoff = opts.horizonCutoff;
      return [];
    },
    fetchIssues: () => [],
    readSnapshot: () => ({ pr: {}, issue: {}, meta: { horizon: '2026-07-01T11:00:00.000Z' } }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
  };
  const { code } = run(['--repo', 'o/r', '--monitor-id', 'main', '--state-file', '/tmp/x.json'], d);
  assert.equal(code, 0);
  assert.equal(receivedCutoff, '2026-07-01T10:55:00.000Z');
  assert.equal(d.written.meta.horizon, '2026-07-01T12:00:00.000Z');
});

test('--detail reports the current missing tick for still-missing', () => {
  const d = {
    fetchPRs: () => [],
    fetchIssues: () => [],
    readSnapshot: () => ({
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
          missing: true,
          missingTicks: 1,
        },
      },
      issue: {},
    }),
    writeSnapshotAtomic: (_p, data) => {
      d.written = data;
    },
    now: () => '2026-07-01T12:00:00.000Z',
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
      'pr',
      '--detail',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.deltas[0].classes, ['still-missing']);
  assert.equal(report.deltas[0].missingTicks, 2);
  assert.equal(report.deltas[0].details[0].missingTicks, 2);
});

test('mixed-case --repo shares one snapshot and one eventId space', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'MERGED', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: {
          state: 'OPEN',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'da39a3ee5e6b',
          review: 'REVIEW_REQUIRED',
          reviews: 'da39a3ee5e6b',
          mergeable: 'UNKNOWN',
          comments: 0,
          head: 'sha1',
        },
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'O/R',
      '--monitor-id',
      'main',
      '--state-dir',
      '/tmp/state',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(report.repo, 'o/r');
  assert.equal(d.readPath, '/tmp/state/repo-o%2Fr__monitor-main__pr-issue.json');
  assert.equal(posts[0].eventId, 'gh-delta.delta.v1:o/r:main:pr:42:merged');
  assert.match(posts[0].links.html, /^https:\/\/github\.com\/o\/r\/pull\/42$/);
});

test('list subcommand returns a read-only inventory report with code 0', () => {
  const calls = [];
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: (stateDir, options) => {
      calls.push([stateDir, options.sinceMs]);
      return {
        monitors: [
          {
            repo: 'o/r',
            monitorId: 'prs-5m',
            entities: ['pr'],
            stateFile: '/state/repo-o%2Fr__monitor-prs-5m__pr.json',
            lastRun: '2026-07-08T11:00:00.000Z',
            prCount: 2,
            issueCount: 0,
          },
        ],
        skippedFiles: 1,
      };
    },
  };
  const { code, report } = run(['list', '--state-dir', '/state', '--since', '24h'], d);
  assert.equal(code, 0);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, 'list');
  assert.equal(report.stateDir, '/state');
  assert.equal(report.since, '24h');
  assert.equal(report.at, '2026-07-08T12:00:00.000Z');
  assert.equal(report.monitors.length, 1);
  assert.equal(report.skippedFiles, 1);
  assert.equal(report.summary, '1 monitor(s)');
  assert.deepEqual(calls, [['/state', 86_400_000]]);
});

test('list rejects an invalid --since as a permanent config error', () => {
  const { code, report } = run(['list', '--since', 'yesterday'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--since/);
});

test('list maps an unreadable state directory to a transient io error', () => {
  const { code, report } = run(['list', '--state-dir', '/state'], {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(code, 1);
  assert.equal(report.kind, 'io');
  assert.match(report.error, /EACCES/);
});

test('list --help and --help-json describe the subcommand without touching disk', () => {
  const d = {
    listMonitors: () => {
      throw new Error('must not be called');
    },
  };
  const helpText = run(['list', '--help'], d);
  assert.equal(helpText.code, 0);
  assert.match(helpText.report, /gh-delta list \[--state-dir <dir>\]/);
  const helpJson = run(['list', '--help-json'], d);
  assert.equal(helpJson.code, 0);
  const help = JSON.parse(helpJson.report);
  assert.equal(help.command, 'gh-delta list');
  assert.ok(help.options.some((option) => option.name === '--since'));
  assert.equal(
    help.exitCodes.find((entry) => entry.code === 0)?.meaning.includes('Inventory'),
    true,
  );
});

test('main --help advertises the list subcommand', () => {
  const { report } = run(['--help'], {});
  assert.match(report, /Subcommands:/);
  assert.match(report, /\n {2}list\s+Read-only inventory/);
});

test('list --format text renders one line per monitor plus skipped files', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({
      monitors: [
        {
          repo: 'o/r',
          monitorId: 'prs-5m',
          entities: ['pr', 'issue'],
          stateFile: '/state/x.json',
          lastRun: '2026-07-08T11:00:00.000Z',
          prCount: 2,
          issueCount: 3,
        },
        {
          repo: 'o/r',
          monitorId: 'broken',
          entities: ['pr'],
          stateFile: '/state/y.json',
          lastRun: '2026-07-08T10:00:00.000Z',
          prCount: null,
          issueCount: null,
          error: 'invalid snapshot JSON at /state/y.json',
        },
      ],
      skippedFiles: 2,
    }),
  };
  const { code, output } = await runCommand(
    ['list', '--state-dir', '/state', '--format', 'text'],
    d,
  );
  assert.equal(code, 0);
  assert.match(output, /^2026-07-08T12:00:00\.000Z \| 2 monitor\(s\) \| \/state\n/);
  assert.match(
    output,
    /o\/r \| monitor: prs-5m \| entities: pr,issue \| last run: 2026-07-08T11:00:00\.000Z \| 2 PR\(s\), 3 issue\(s\)/,
  );
  assert.match(output, /o\/r \| monitor: broken \| .* \| snapshot error: invalid snapshot JSON/);
  assert.match(output, /2 unrecognized file\(s\) skipped\./);
});

test('list --format text reports an empty inventory and echoes the window', async () => {
  const d = {
    now: () => '2026-07-08T12:00:00.000Z',
    listMonitors: () => ({ monitors: [], skippedFiles: 0 }),
  };
  const windowed = await runCommand(
    ['list', '--state-dir', '/state', '--since', '1h', '--format', 'text'],
    d,
  );
  assert.match(windowed.output, /No monitor snapshots ran in the last 1h\./);
  const bare = await runCommand(['list', '--state-dir', '/state', '--format', 'text'], d);
  assert.match(bare.output, /No monitor snapshots found\./);
});
