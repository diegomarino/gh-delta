// Agent-oriented render shapes. Rendering happens after a detector tick; this
// module is pure and intentionally does not participate in state publication.
import { DELTA_CLASSES, REPORT_SCHEMA_VERSION } from './contract.mjs';
import { diffFingerprint } from './diff.mjs';
import { deltaSummary } from './summary.mjs';

function countsFor(deltas, filteredDeltas) {
  const byClass = {};
  for (const name of DELTA_CLASSES) {
    const count = deltas.filter((delta) => delta.classes?.includes(name)).length;
    if (count) byClass[name] = count;
  }
  return {
    deltas: deltas.length,
    byClass,
    ...(filteredDeltas !== undefined ? { filteredDeltas } : {}),
  };
}
function urlFor(delta, repo) {
  return `https://github.com/${repo}/${delta.entity === 'pr' ? 'pull' : 'issues'}/${delta.number}`;
}
export function compactDelta(delta, { detail = false, repo: reportRepo } = {}) {
  const repo = delta.repo ?? reportRepo;
  return {
    id: delta.id,
    repo,
    entity: delta.entity,
    number: delta.number,
    title: delta.title,
    url: urlFor(delta, repo),
    classes: delta.classes,
    summary: delta.summary ?? deltaSummary(delta),
    changed: diffFingerprint(delta.from?.fingerprint, delta.to?.fingerprint),
    ...(delta.missingTicks !== undefined ? { missingTicks: delta.missingTicks } : {}),
    ...(delta.enrichment !== undefined ? { enrichment: delta.enrichment } : {}),
    ...(detail && delta.details !== undefined ? { detail: delta.details } : {}),
  };
}
function compactErrors(report) {
  if (Array.isArray(report.errors)) return report.errors;
  if (!report.error) return undefined;
  return [
    {
      ...(report.repo ? { repo: report.repo } : {}),
      kind: report.kind,
      message: report.error,
      hint: report.hint,
      ...(report.resetAt ? { resetAt: report.resetAt } : {}),
    },
  ];
}
/** Create the compact envelope, retaining only the agent contract fields. */
export function compactReport(report, _code = 0, warnings = [], options = {}) {
  const deltas = (report.deltas ?? []).map((delta) =>
    compactDelta(delta, { ...options, repo: report.repo }),
  );
  const errors = compactErrors(report);
  const base = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...(Array.isArray(report.repos)
      ? { repos: report.repos }
      : report.repo
        ? { repo: report.repo }
        : {}),
    at: report.at,
    ...(Array.isArray(report.repos) ? {} : { baseline: report.baseline ?? false }),
    counts: countsFor(deltas, report.filteredDeltas),
    deltas,
    ...(errors !== undefined ? { errors } : {}),
  };
  return { ...base, ...(warnings.length ? { warnings } : {}) };
}
/** Render one compact record per delta followed by exactly one end record. */
export function ndjsonReport(report, code = 0, warnings = [], options = {}) {
  const compact = compactReport(report, code, warnings, options);
  const records = compact.deltas.map((delta) => ({ type: 'delta', ...delta }));
  const end = {
    type: 'end',
    schemaVersion: compact.schemaVersion,
    at: compact.at,
    ...(compact.repo
      ? { repo: compact.repo, baseline: compact.baseline }
      : compact.repos
        ? { repos: compact.repos }
        : {}),
    counts: compact.counts,
    ...(compact.errors !== undefined ? { errors: compact.errors } : {}),
    ...(compact.warnings !== undefined ? { warnings: compact.warnings } : {}),
    exitCode: code,
  };
  return `${[...records, end].map((row) => JSON.stringify(row)).join('\n')}\n`;
}
