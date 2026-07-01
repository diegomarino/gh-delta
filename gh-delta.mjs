#!/usr/bin/env node
// Deterministic detector CLI: reads GitHub state, diffs it against a snapshot,
// writes the next snapshot, and reports only facts. It does not schedule or act.
import { parseArgs } from 'node:util';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './lib/gh.mjs';
import { detectDeltas } from './lib/detect.mjs';
import { readSnapshot as fsRead, writeSnapshotAtomic as fsWrite } from './lib/snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './lib/outpost.mjs';
import { parseEntitySelection, parseOutpostArgs } from './lib/args.mjs';

const usage = `Usage:
  gh-delta --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--detail] [--outpost-url <url>]

Options:
  --repo        GitHub repository in owner/name form. Required.
  --state-file  Snapshot JSON path. Required.
  --branch      Branch or watch-loop name to include in reports.
  --entities    Comma-separated entity list: pr, issue, or pr,issue. Default: pr,issue.
  --detail      Add one human-readable line per delta.
  --outpost-url Send one fire-and-forget HTTP POST per delta when exit code is 10.
  --help        Show this help.

Exit codes:
  0   Baseline established or no deltas.
  10  Deltas found.
  1   GitHub CLI, network, parse, or argument error. Snapshot is not updated on errors.
`;

function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.title}": ${d.classes.join(', ')}`;
}

// deps keeps the CLI testable without shelling out to gh or touching disk.
export function run(argv, deps = {}) {
  const {
    fetchPRs = ghPRs,
    fetchIssues = ghIssues,
    readSnapshot = fsRead,
    writeSnapshotAtomic = fsWrite,
    now = () => new Date().toISOString(),
  } = deps;
  const at = now();
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        entities: { type: 'string', default: 'pr,issue' },
        'state-file': { type: 'string' },
        detail: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    return { code: 1, report: { error: String(err?.message ?? err), at } };
  }
  if (values.help) return { code: 0, report: usage };
  if (!values.repo)
    return { code: 1, report: { error: 'missing required --repo <owner/name>', at } };
  if (!values['state-file'])
    return {
      code: 1,
      report: { error: 'missing required --state-file <path>', repo: values.repo, at },
    };
  const entitySelection = parseEntitySelection(values.entities);
  if (!entitySelection.ok) {
    return {
      code: 1,
      report: {
        error: `--entities must include pr, issue, or both; got "${values.entities}"`,
        repo: values.repo,
        at,
      },
    };
  }
  try {
    // Fetch broadly; filtering too early would make close/merge/relabel events disappear.
    const current = {
      pr: entitySelection.wantsPr ? fetchPRs(values.repo) : undefined,
      issue: entitySelection.wantsIssue ? fetchIssues(values.repo) : undefined,
    };
    const old = readSnapshot(values['state-file']);
    const { baseline, deltas, snapshot } = detectDeltas(old, current);
    if (values.detail) for (const d of deltas) d.line = line(d);
    writeSnapshotAtomic(values['state-file'], snapshot);
    const summary = baseline
      ? `baseline established: ${Object.keys(snapshot.pr).length} PRs, ${Object.keys(snapshot.issue).length} issues`
      : `${deltas.length} delta(s)`;
    const report = { baseline, repo: values.repo, branch: values.branch, at, deltas, summary };
    return { code: baseline || deltas.length === 0 ? 0 : 10, report };
  } catch (err) {
    const report = { error: String(err?.message ?? err), repo: values.repo, at };
    return { code: 1, report };
  }
}

export async function runWithOutpost(argv, deps = {}) {
  const {
    outpostFetch = globalThis.fetch,
    outpostTimeoutMs,
    now = () => new Date().toISOString(),
  } = deps;
  const parsed = parseOutpostArgs(argv);
  if (parsed.error) return { code: 1, report: { error: parsed.error, at: now() }, warnings: [] };

  let outpostUrl;
  if (parsed.outpostUrl !== undefined) {
    const validation = validateOutpostUrl(parsed.outpostUrl);
    if (!validation.ok)
      return { code: 1, report: { error: validation.error, at: now() }, warnings: [] };
    outpostUrl = validation.url;
  }

  const result = run(parsed.detectorArgs, deps);
  if (!outpostUrl || result.code !== 10 || typeof result.report === 'string') {
    return { ...result, warnings: [] };
  }

  const { warnings } = await sendOutposts({
    outpostUrl,
    report: result.report,
    fetchImpl: outpostFetch,
    timeoutMs: outpostTimeoutMs,
  });
  return { ...result, warnings };
}

function formatOutpostWarnings(warnings = []) {
  return warnings
    .map((warning) => `outpost warning: ${warning.label} failed: ${warning.reason}`)
    .join('\n');
}

// CLI entrypoint: only runs when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, report, warnings } = await runWithOutpost(process.argv.slice(2));
  if (warnings?.length) process.stderr.write(`${formatOutpostWarnings(warnings)}\n`);
  process.stdout.write(
    typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
  );
  process.exit(code);
}
