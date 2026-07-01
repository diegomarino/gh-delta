#!/usr/bin/env node
// Operator-friendly tick wrapper. It turns the detector's JSON/exit code into
// heartbeat text and suggested next actions, but still leaves judgment to an agent.
import { run as runDetector } from './gh-delta.mjs';
import { sendOutposts, validateOutpostUrl } from './lib/outpost.mjs';

const usage = `Usage:
  gh-delta-tick --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--outpost-url <url>]

Runs one scheduler-owned watcher tick. The script never creates timers, cron jobs,
automations, or wake-ups.
`;

const SUGGESTIONS = [
  {
    matches: ['ci-changed', 'review-changed'],
    text: 'CI/review changed. Read checks and review threads before merge.',
  },
  {
    matches: ['new-comments'],
    text: 'new comments. Read the PR/issue thread before taking action.',
  },
  {
    matches: ['new'],
    text: 'new item. Read it and queue or recommend review.',
  },
  {
    matches: ['became-mergeable'],
    text: 'conflicts resolved. Consider the merge path after review.',
  },
  {
    matches: ['merged', 'closed'],
    text: 'item completed or closed. Advance build order or sync the base.',
  },
  {
    matches: ['relabeled'],
    text: 'scope/state changed. Reassess dispatch.',
  },
  {
    matches: ['missing'],
    text: 'object disappeared from the fetch. Check pagination, permissions, or scope before trusting the snapshot.',
  },
  {
    matches: ['still-missing'],
    text: 'object is still absent from the fetch. Treat as an unresolved operational issue, not a fresh item.',
  },
  {
    matches: ['updated'],
    text: 'metadata or head changed. Inspect GitHub, including comments and review threads, before dismissing.',
  },
];

// Keep argument handling minimal; the detector owns validation of repo/state flags.
function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function tickArgs(argv) {
  return hasFlag(argv, '--detail') ? argv : [...argv, '--detail'];
}

function extractOutpostUrl(argv) {
  const detectorArgs = [];
  let outpostUrl;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outpost-url') {
      if (outpostUrl !== undefined) return { error: '--outpost-url may only be provided once' };
      const value = argv[i + 1];
      if (value === undefined) return { error: '--outpost-url requires a URL' };
      outpostUrl = value;
      i++;
      continue;
    }
    if (arg.startsWith('--outpost-url=')) {
      if (outpostUrl !== undefined) return { error: '--outpost-url may only be provided once' };
      outpostUrl = arg.slice('--outpost-url='.length);
      continue;
    }
    detectorArgs.push(arg);
  }
  return { detectorArgs, outpostUrl };
}

function deltaLabel(delta) {
  return delta.line ?? `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${delta.classes.join(', ')}`;
}

function suggestionFor(classes = []) {
  // First matching suggestion wins; high-signal classes are ordered first above.
  const found = SUGGESTIONS.find((entry) => entry.matches.some((name) => classes.includes(name)));
  return found?.text ?? 'inspect this delta and decide the next action.';
}

function formatDeltas(deltas = []) {
  return deltas.map((delta) => {
    return [
      deltaLabel(delta),
      `classes: ${delta.classes.join(', ')}`,
      `suggested action: ${suggestionFor(delta.classes)}`,
    ].join('\n');
  }).join('\n\n');
}

function formatOutput({ code, report, now }) {
  if (typeof report === 'string') return report;

  const at = report.at ?? now();
  if (code === 1) {
    return [
      `${at} | error | 0 delta(s)`,
      '',
      `gh-delta error: ${report.error ?? 'unknown error'}`,
      'Snapshot was not updated. No action taken. The next scheduled tick should retry.',
    ].join('\n');
  }

  const deltas = report.deltas ?? [];
  const heartbeat = `${at} | ${deltas.length} delta(s)`;
  if (report.baseline) {
    return [
      heartbeat,
      '',
      `Baseline seeded for ${report.repo}.`,
      'No action taken.',
    ].join('\n');
  }

  if (deltas.length === 0) {
    return [
      heartbeat,
      '',
      'No GitHub deltas since the last snapshot.',
    ].join('\n');
  }

  return [
    heartbeat,
    '',
    formatDeltas(deltas),
  ].join('\n');
}

function formatOutpostWarnings(warnings = []) {
  if (warnings.length === 0) return '';
  return [
    '',
    '',
    ...warnings.map((warning) => `outpost warning: ${warning.label} failed: ${warning.reason}`),
  ].join('\n');
}

export async function runTick(argv, deps = {}) {
  const {
    detector = (args) => runDetector(args),
    now = () => new Date().toISOString(),
    outpostFetch = globalThis.fetch,
    outpostTimeoutMs,
  } = deps;

  if (hasFlag(argv, '--help')) return { code: 0, output: usage };

  const parsed = extractOutpostUrl(argv);
  if (parsed.error) {
    return {
      code: 1,
      output: `${formatOutput({ code: 1, report: { error: parsed.error, at: now() }, now })}\n`,
    };
  }

  let outpostUrl;
  if (parsed.outpostUrl !== undefined) {
    const validation = validateOutpostUrl(parsed.outpostUrl);
    if (!validation.ok) {
      return {
        code: 1,
        output: `${formatOutput({ code: 1, report: { error: validation.error, at: now() }, now })}\n`,
      };
    }
    outpostUrl = validation.url;
  }

  let code;
  let report;
  try {
    // Force --detail so scheduled prompts get stable, human-readable delta labels.
    ({ code, report } = await detector(tickArgs(parsed.detectorArgs)));
  } catch (err) {
    code = 1;
    report = { error: String(err?.message ?? err), at: now() };
  }

  let outpostWarnings = [];
  if (outpostUrl && code === 10 && typeof report !== 'string') {
    ({ warnings: outpostWarnings } = await sendOutposts({
      outpostUrl,
      report,
      fetchImpl: outpostFetch,
      timeoutMs: outpostTimeoutMs,
    }));
  }

  return {
    code,
    output: `${formatOutput({ code, report, now })}${formatOutpostWarnings(outpostWarnings)}\n`,
  };
}

// CLI entrypoint: keep process I/O here so tests can call runTick directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, output } = await runTick(process.argv.slice(2));
  process.stdout.write(output);
  process.exit(code);
}
