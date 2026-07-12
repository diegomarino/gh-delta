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
    matches: ['first-seen'],
    text: 'first observed item. Inspect before treating it as newly created.',
  },
  {
    matches: ['became-mergeable'],
    text: 'conflicts resolved. Consider the merge path after review.',
  },
  {
    matches: ['draft-ready'],
    text: 'PR left draft and is ready for review. Queue it for review or dispatch.',
  },
  {
    matches: ['reopened'],
    text: 'item reopened. Re-enter it into the active work queue.',
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

// Neutralize terminal control sequences from GitHub-derived text before it
// reaches an operator terminal. Anyone who can open an issue/PR controls the
// title; a raw ESC/OSC/BEL or newline could rewrite the terminal title, hijack
// state, or forge a second line that looks like a genuine delta. C0 controls,
// DEL, and C1 controls (including ESC, BEL, CR, LF, TAB) collapse to a space;
// the structural newlines/tabs the renderer adds itself are untouched because
// this only runs per field, never over the assembled output.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
function sanitizeField(value) {
  return String(value).replace(CONTROL_CHARS, ' ');
}

/**
 * Return the human-visible line used in text output for one delta.
 */
function deltaLabel(delta) {
  return sanitizeField(
    delta.summaryLine ??
      delta.line ??
      `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${delta.classes.join(', ')}`,
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
 * Render one inventory line per monitor for `gh-delta list` text output.
 */
function monitorLine(monitor) {
  const counts = monitor.stale
    ? 'stale: snapshot file is gone'
    : monitor.error
      ? `snapshot error: ${monitor.error}`
      : `${monitor.prCount} PR(s), ${monitor.issueCount} issue(s)`;
  return [
    monitor.repo,
    `monitor: ${monitor.monitorId}`,
    `entities: ${monitor.entities.join(',')}`,
    `last run: ${monitor.lastRun}`,
    counts,
    // Always print the snapshot path so monitors that share repo + monitor-id +
    // entities render as distinct lines instead of visually identical ones.
    `file: ${monitor.stateFile}`,
  ].join(' | ');
}

/**
 * Render the human-readable output for a `gh-delta list` report.
 *
 * Both success and error reports render here so the read-only inventory command
 * never borrows the detector's snapshot/delta vocabulary: a failed `list` run
 * has no snapshot to preserve and no deltas to count.
 */
export function formatListTextOutput({ report }) {
  if (report.error) {
    return [
      `${report.at} | list error`,
      '',
      `gh-delta list error: ${report.error}`,
      'No inventory produced. Fix the flags and re-run; nothing was read or written.',
    ].join('\n');
  }
  const scope = report.registryDir ? `${report.stateDir} + registry` : report.stateDir;
  const heartbeat = `${report.at} | ${report.monitors.length} monitor(s) | ${scope}`;
  const lines = [heartbeat, ''];
  if (report.monitors.length === 0) {
    lines.push(
      report.since
        ? `No monitor snapshots ran in the last ${report.since}.`
        : 'No monitor snapshots found.',
    );
  } else {
    lines.push(...report.monitors.map(monitorLine));
  }
  if (report.skippedFiles > 0) {
    lines.push('', `${report.skippedFiles} unrecognized file(s) skipped.`);
  }
  return lines.join('\n');
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
