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
    matches: ['comments-removed'],
    text: 'comments were deleted. Re-read the thread; prior context may be gone.',
  },
  {
    matches: ['review-comments-added'],
    text: 'new review thread replies. Read the review thread before taking action.',
  },
  {
    matches: ['review-comments-removed'],
    text: 'review thread replies were deleted. Re-read the thread; prior context may be gone.',
  },
  {
    matches: ['review-requests-changed'],
    text: 'requested reviewers changed. Check who is now expected to review.',
  },
  {
    matches: ['assignees-changed'],
    text: 'assignees changed. Check who now owns the item before dispatching.',
  },
  {
    matches: ['base-changed'],
    text: 'base branch changed. Re-check CI and mergeability against the new base.',
  },
  {
    matches: ['head-changed'],
    text: 'head commit changed (push, rebase, or force-push). Re-check CI and review state before trusting prior approvals.',
  },
  {
    matches: ['stale'],
    text: 'item is stale. Re-check ownership and request an update before proceeding.',
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
    matches: ['baseline-state'],
    text: 'state observed at baseline seed. Inspect for pre-existing trouble; not newly created.',
  },
  {
    matches: ['became-mergeable'],
    text: 'conflicts resolved. Consider the merge path after review.',
  },
  {
    matches: ['became-conflicting'],
    text: 'PR now conflicts with its base. Rebase or resolve before merge.',
  },
  {
    matches: ['draft-ready'],
    text: 'PR left draft and is ready for review. Queue it for review or dispatch.',
  },
  {
    matches: ['converted-to-draft'],
    text: 'PR went back to draft. Hold review and merge actions until it is ready again.',
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
    text: 'metadata changed with no other specific signal. Inspect GitHub, including comments and review threads, before dismissing.',
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
  const label = sanitizeField(
    delta.summaryLine ??
      `${delta.entity.toUpperCase()} #${delta.number} "${delta.context?.title ?? '(no title)'}": ${delta.classes.join(', ')}`,
  );
  return delta.repo ? `${sanitizeField(delta.repo)} | ${label}` : label;
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

  // Pre-flight bare error: no repo was ever resolved, so there is no
  // repos/results envelope to render (see lib/cli/runner.mjs's run()). Unrenamed
  // `at` here, matching that bare shape's field name.
  if (report?.error) {
    const at = report.at ?? now();
    const retryLine =
      code === 2
        ? 'Snapshot was not updated. Fix the configuration or snapshot; retrying will not help.'
        : 'Snapshot was not updated. No action taken. The next scheduled tick should retry.';
    return [
      `${at} | error | 0 delta(s)`,
      '',
      `gh-delta error: ${report.error ?? 'unknown error'}`,
      ...(report.hint ? [`hint: ${report.hint}`] : []),
      retryLine,
    ].join('\n');
  }

  const at = report.detectedAt ?? now();
  const deltas = report.deltas ?? [];
  const results = report.results ?? [];

  if (results.length > 1) {
    const errors = results.filter((row) => row.error);
    return [
      `${at} | ${deltas.length} delta(s) across ${report.repos.length} repo(s)`,
      '',
      ...(deltas.length
        ? formatDeltas(deltas).split('\n')
        : ['No successful repository produced a delta.']),
      ...(errors.length
        ? [
            '',
            'Partial errors:',
            ...errors.map(
              (row) =>
                `${row.repo} | ${row.error.kind}: ${row.error.message}${row.error.hint ? ` | hint: ${row.error.hint}` : ''}`,
            ),
          ]
        : []),
      'Successful repository snapshots may have advanced.',
    ].join('\n');
  }

  const single = results[0] ?? {};
  const heartbeat = `${at} | ${deltas.length} delta(s)`;
  const filterNotice =
    report.filteredDeltas > 0
      ? `Attention filters suppressed ${report.filteredDeltas} delta(s); snapshot advanced and they will not be replayed.`
      : null;

  if (single.error) {
    const retryLine =
      code === 2
        ? 'Snapshot was not updated. Fix the configuration or snapshot; retrying will not help.'
        : 'Snapshot was not updated. No action taken. The next scheduled tick should retry.';
    return [
      `${at} | error | 0 delta(s)`,
      '',
      `gh-delta error: ${single.error.message ?? 'unknown error'}`,
      ...(single.error.hint ? [`hint: ${single.error.hint}`] : []),
      retryLine,
    ].join('\n');
  }

  if (single.baseline) {
    return [
      heartbeat,
      '',
      `Baseline seeded for ${single.repo} (monitor: ${report.monitorId}).`,
      ...(filterNotice ? [filterNotice] : []),
      'No action taken.',
    ].join('\n');
  }

  if (deltas.length === 0) {
    return [
      heartbeat,
      '',
      ...(filterNotice ? [filterNotice] : []),
      report.filteredDeltas > 0
        ? 'No deltas remain after attention filtering.'
        : 'No GitHub deltas since the last snapshot.',
    ].join('\n');
  }

  return [heartbeat, '', ...(filterNotice ? [filterNotice] : []), formatDeltas(deltas)].join('\n');
}

/** Concise one-row-per-check diagnostic output for `gh-delta doctor`. */
export function formatDoctorTextOutput({ report }) {
  if (report?.error) return `doctor error: ${report.error}\nhint: ${report.hint}`;
  return (report.checks ?? [])
    .map((check) => `${check.ok ? 'ok' : check.level} | ${check.name} | ${check.detail}`)
    .join('\n');
}

export function formatInitTextOutput({ report }) {
  if (report?.error) return `init error: ${report.error}\nhint: ${report.hint}`;
  return `initialized ${report.repo} at ${report.stateDir}\nnext: ${report.nextCommand}`;
}

export function formatExplainTextOutput({ report }) {
  if (report?.error) return `explain error: ${report.error}\nhint: ${report.hint}`;
  return `${report.id}: ${JSON.stringify(report.changed)}`;
}

export function formatDemoTextOutput({ report }) {
  if (report?.error) return `demo error: ${report.error}\nhint: ${report.hint}`;
  return report.commandLine;
}

/**
 * Render one inventory line per monitor for `gh-delta list` text output.
 */
function monitorLine(monitor) {
  const counts =
    monitor.snapshotStatus === 'not-yet-created'
      ? 'no successful observation yet'
      : monitor.stale
        ? 'stale: snapshot file is gone'
        : monitor.error
          ? `snapshot error: ${monitor.error}`
          : `${monitor.prCount} PR(s), ${monitor.issueCount} issue(s)`;
  return [
    monitor.repo,
    `monitor: ${monitor.monitorId}`,
    `entities: ${monitor.entities.join(',')}`,
    ...(monitor.scope ? [`scope: ${monitor.scope}`] : []),
    `schema: ${monitor.schemaVersion ?? '-'}`,
    `last run: ${monitor.lastRun}`,
    counts,
    `watched: ${monitor.watched ?? `error: ${monitor.watchError ?? 'unknown'}`}`,
    `last attempt: ${monitor.lastAttemptAt ?? '-'}`,
    `last ok: ${monitor.lastOkAt ?? '-'}`,
    `snapshot: ${monitor.snapshotStatus ?? 'present'}`,
    `observation age: ${monitor.observationAgeMs ?? '-'}`,
    ...(monitor.lastError
      ? [`last error: ${monitor.lastError.kind}: ${monitor.lastError.message}`]
      : []),
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
      ...(report.hint ? [`hint: ${report.hint}`] : []),
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

export function formatWatchTextOutput({ report }) {
  if (report.error)
    return `${report.at} | watch error\n\n${report.error}${report.hint ? `\nhint: ${report.hint}` : ''}`;
  if (report.command === 'watch ls')
    return [
      `${report.at} | watch ls | ${report.entries.length} item(s)`,
      `path: ${report.watchDir}`,
      ...report.entries.map((entry) => `${entry.entity}:${entry.number} until ${entry.until}`),
    ].join('\n');
  const item = report.entry ? `${report.entry.entity}:${report.entry.number}` : report.item;
  return `${report.at} | ${report.command}\npath: ${report.watchDir}\nitem: ${item}\n${(report.added ?? report.removed) ? 'changed' : 'unchanged'}`;
}

/** Render the local snapshot status without pretending it is a detector run. */
export function formatStatusTextOutput({ report, now }) {
  const at = report.at ?? now();
  if (report.error)
    return [
      `${at} | status error`,
      '',
      `gh-delta status error: ${report.error}`,
      ...(report.hint ? [`hint: ${report.hint}`] : []),
      'No status was produced.',
    ].join('\n');
  return [
    `${at} | Status ${report.repo} (${report.items.length} open item(s))`,
    `monitor: ${report.monitorId}`,
    `snapshot: ${report.stateFile}`,
    ...report.items.map((item) =>
      [
        `${item.entity.toUpperCase()} #${item.number}${item.title ? ` ${sanitizeField(item.title)}` : ''}`,
        `author=${item.author ? sanitizeField(item.author) : '-'}`,
        `lastChangedAt=${item.lastChangedAt ?? '-'}`,
        `ticksSinceChange=${item.ticksSinceChange}`,
        ...(item.summary
          ? [
              `ci=${item.summary.ciRollup}`,
              `review=${item.summary.reviewDecision}`,
              `state=${item.summary.state}`,
            ]
          : []),
      ].join(' | '),
    ),
  ].join('\n');
}

/** Operator-safe replay result. Read deliberately has no snapshot vocabulary. */
export function formatReadTextOutput({ code, report, now }) {
  const at = report.at ?? now();
  if (report.error) {
    return [
      `${at} | read error | 0 delta(s)`,
      '',
      `gh-delta read error: ${report.error}`,
      ...(report.hint ? [`hint: ${report.hint}`] : []),
      code === 2
        ? 'No cursor was changed. Fix the cursor or log before retrying.'
        : 'No cursor was changed. Retry after the filesystem error is resolved.',
    ].join('\n');
  }
  const cursor = report.cursor;
  return [
    `${at} | read | ${report.deltas.length} delta(s)`,
    `cursor: ${cursor.from} -> ${cursor.to}; advanced: ${cursor.advanced}`,
    ...(report.deltas.length
      ? ['', formatDeltas(report.deltas)]
      : ['', 'No matching deltas in the scanned log tail.']),
  ].join('\n');
}

/** Operator-safe cursor mutation result. */
export function formatCursorSetTextOutput({ report, now }) {
  const at = report.at ?? now();
  if (report.error) {
    return [
      `${at} | cursor set error`,
      '',
      `gh-delta cursor set error: ${report.error}`,
      ...(report.hint ? [`hint: ${report.hint}`] : []),
      'Cursor was not changed.',
    ].join('\n');
  }
  return [
    `${at} | cursor set`,
    `cursor: ${report.cursor.from} -> ${report.cursor.to}`,
    `log: ${report.cursor.logFile}`,
  ].join('\n');
}

export function formatCompactTextOutput({ report, now }) {
  const at = report.at ?? now();
  if (report.error)
    return `${at} | log compact error\n\ngh-delta log compact error: ${report.error}${report.hint ? `\nhint: ${report.hint}` : ''}`;
  return [
    `${at} | log compact | ${report.summary}`,
    `log: ${report.logFile}`,
    `keep: ${report.keep}`,
    `previous: ${report.previous.firstSeq ?? '-'}..${report.previous.lastSeq}; ${report.previous.count} record(s)`,
    `retained: ${report.retained.firstSeq ?? '-'}..${report.retained.lastSeq ?? '-'}; ${report.retained.count} record(s)`,
  ].join('\n');
}

export function formatResetTextOutput({ report, now }) {
  const at = report.at ?? now();
  if (report.error)
    return `${at} | reset error\n\ngh-delta reset error: ${report.error}${report.hint ? `\nhint: ${report.hint}` : ''}`;
  return [
    `${at} | ${report.summary}`,
    `state file: ${report.stateFile}`,
    `log: ${report.logFile}`,
    ...(report.targets ?? []).map(
      (target) =>
        `${target.scope}: ${target.removed.length} removed, ${target.missing.length} absent`,
    ),
  ].join('\n');
}

/**
 * Render warnings — derivation and outpost delivery alike, both uniform
 * `{ label, reason }` objects — into text-safe log lines.
 */
export function formatOutpostWarnings(warnings = []) {
  if (warnings.length === 0) return '';
  return [
    '',
    '',
    ...warnings.map((warning) => `warning [${warning.label}]: ${warning.reason}`),
  ].join('\n');
}
