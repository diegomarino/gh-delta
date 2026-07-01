#!/usr/bin/env node
// Deterministic detector CLI: reads GitHub state, diffs it against a snapshot,
// writes the next snapshot, and reports only facts. It does not schedule or act.
import { parseArgs } from 'node:util';
import { fetchPRs as ghPRs, fetchIssues as ghIssues } from './lib/gh.mjs';
import { detectDeltas } from './lib/detect.mjs';
import { readSnapshot as fsRead, writeSnapshotAtomic as fsWrite } from './lib/snapshot.mjs';
import { sendOutposts, validateOutpostUrl } from './lib/outpost.mjs';
import { parseEntitySelection, parseOutpostArgs } from './lib/args.mjs';
import { isDirectEntrypoint } from './lib/entrypoint.mjs';
import { renderHelpJson, renderHelpText } from './lib/help.mjs';

function line(d) {
  return `${d.entity.toUpperCase()} #${d.number} "${d.title}": ${d.classes.join(', ')}`;
}

// deps keeps the CLI testable without shelling out to gh or touching disk.
/**
 * Run one detector pass and return a machine-readable result.
 *
 * The function performs argument validation, fetches requested GitHub entity
 * families, compares them with the prior snapshot, and writes the next snapshot
 * only after a successful fetch and diff. It never exits the process directly.
 */
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
        'help-json': { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    return { code: 1, report: { error: String(err?.message ?? err), at } };
  }
  if (values.help) return { code: 0, report: renderHelpText('gh-delta') };
  if (values['help-json']) return { code: 0, report: renderHelpJson('gh-delta') };
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

/**
 * Run the detector and optionally deliver one outpost event per delta.
 *
 * Outpost validation happens before GitHub fetches. Delivery happens after the
 * snapshot write and returns warnings instead of changing the detector code.
 */
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
if (isDirectEntrypoint(import.meta.url)) {
  const { code, report, warnings } = await runWithOutpost(process.argv.slice(2));
  if (warnings?.length) process.stderr.write(`${formatOutpostWarnings(warnings)}\n`);
  process.stdout.write(
    typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
  );
  process.exit(code);
}
