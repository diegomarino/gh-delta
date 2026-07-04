// Operator-friendly text output for scheduled or human-readable detector runs.
const SUGGESTIONS = [
  {
    matches: ['merged', 'closed'],
    text: 'item completed or closed. Advance build order or sync the base.',
  },
  {
    matches: ['ci-changed', 'review-changed'],
    text: 'CI/review changed. Read checks and review threads before merge.',
  },
  {
    matches: ['new-comments'],
    text: 'new comments. Read the PR/issue thread before taking action.',
  },
  {
    matches: ['unresolved-threads-added'],
    text: 'unresolved review threads. Read and resolve them before merge.',
  },
  {
    matches: ['unresolved-threads-resolved'],
    text: 'review threads resolved. Re-check CI and review state before merge.',
  },
  {
    matches: ['review-threads-changed'],
    text: 'review thread activity changed. Inspect review threads before acting.',
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
    matches: ['presumed-deleted'],
    text: 'absent for several consecutive ticks; treated as deleted, transferred, or converted. Verify on GitHub; expect silence unless it reappears.',
  },
  {
    matches: ['reappeared'],
    text: 'object returned to the fetch. Check prior missing state before acting.',
  },
  {
    matches: ['updated'],
    text: 'metadata or head changed. Inspect GitHub, including comments and review threads, before dismissing.',
  },
];

/**
 * Return the human-visible line used in text output for one delta.
 */
function deltaLabel(delta) {
  return (
    delta.line ??
    `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${delta.classes.join(', ')}`
  );
}

/**
 * Return the best-effort operator action hint for a delta class list.
 */
function suggestionFor(classes = []) {
  const found = SUGGESTIONS.find((entry) => entry.matches.some((name) => classes.includes(name)));
  return found?.text ?? 'inspect this delta and decide the next action.';
}

/**
 * Render one compact block per delta for human-facing diagnostics.
 */
function formatDeltas(deltas = []) {
  return deltas
    .map((delta) => {
      return [
        deltaLabel(delta),
        `classes: ${delta.classes.join(', ')}`,
        `suggested action: ${suggestionFor(delta.classes)}`,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * Render the full human-readable monitor output for a run result.
 */
export function formatTextOutput({ code, report, now }) {
  if (typeof report === 'string') return report;

  const at = report.at ?? now();
  if (report?.error) {
    const retryLine =
      code === 2
        ? 'Snapshot was not updated. Fix the configuration or snapshot; retrying will not help.'
        : 'Snapshot was not updated. No action taken. The next scheduled tick should retry.';
    return [
      `${at} | error | 0 delta(s)`,
      '',
      `gh-delta error: ${report.error ?? 'unknown error'}`,
      retryLine,
    ].join('\n');
  }

  const deltas = report.deltas ?? [];
  const heartbeat = `${at} | ${deltas.length} delta(s)`;
  if (report.baseline) {
    return [
      heartbeat,
      '',
      `Baseline seeded for ${report.repo} (monitor: ${report.monitorId}).`,
      'No action taken.',
    ].join('\n');
  }

  if (deltas.length === 0) {
    return [heartbeat, '', 'No GitHub deltas since the last snapshot.'].join('\n');
  }

  return [heartbeat, '', formatDeltas(deltas)].join('\n');
}

/**
 * Render warnings returned by outpost delivery into text-safe log lines.
 */
export function formatOutpostWarnings(warnings = []) {
  if (warnings.length === 0) return '';
  return [
    '',
    '',
    ...warnings.map((warning) => `outpost warning: ${warning.label} failed: ${warning.reason}`),
  ].join('\n');
}
