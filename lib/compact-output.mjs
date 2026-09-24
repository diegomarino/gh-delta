// Agent-oriented render shapes. Rendering happens after a detector tick; this
// module is pure and intentionally does not participate in state publication.
import { DELTA_CLASSES, REPORT_SCHEMA_VERSION } from './contract.mjs';

function countsFor(deltas, filteredDeltas) {
  const byClass = {};
  for (const name of DELTA_CLASSES) {
    const count = deltas.filter((delta) => delta.classes?.includes(name)).length;
    if (count) byClass[name] = count;
  }
  return { deltas: deltas.length, byClass, filteredDeltas };
}
// `context`/`changed`/`summary` are precomputed once by lib/cli.mjs's
// enrichDelta and carried on the delta object; this is a plain pick, never a
// recomputation (delta.repo/id/entity/number are always present already).
export function compactDelta(delta, { detail = false, full = false } = {}) {
  return {
    id: delta.id,
    repo: delta.repo,
    entity: delta.entity,
    number: delta.number,
    context: delta.context,
    classes: delta.classes,
    summary: delta.summary,
    changed: delta.changed,
    ...(delta.missingTicks !== undefined ? { missingTicks: delta.missingTicks } : {}),
    ...(delta.enrichment !== undefined ? { enrichment: delta.enrichment } : {}),
    ...(detail && delta.details !== undefined ? { detail: delta.details } : {}),
    ...(full ? { from: delta.from, to: delta.to } : {}),
  };
}
// Bare pre-flight error (no repo ever resolved -- see lib/cli.mjs's run())
// vs. the enveloped repos/results shape, where per-repo failures live.
function compactErrors(report) {
  if (Array.isArray(report.results)) {
    const rows = report.results
      .filter((row) => row.error)
      .map((row) => ({ repo: row.repo, ...row.error }));
    return rows.length ? rows : undefined;
  }
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
  const deltas = (report.deltas ?? []).map((delta) => compactDelta(delta, options));
  const errors = compactErrors(report);
  const base = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...(Array.isArray(report.repos) ? { repos: report.repos } : {}),
    // report.detectedAt is the enveloped detector report's timestamp;
    // report.at is the bare pre-flight error shape's (deliberately
    // unrenamed -- see lib/schema.mjs's bareError), which has no
    // `detectedAt`. Either way, the compact/ndjson envelope's own field is
    // always `detectedAt`.
    detectedAt: report.detectedAt ?? report.at,
    ...(report.repos?.length === 1 ? { baseline: report.results[0].baseline } : {}),
    counts: countsFor(deltas, report.filteredDeltas ?? 0),
    deltas,
    ...(errors !== undefined ? { errors } : {}),
  };
  return { ...base, warnings };
}
/** Render one compact record per delta followed by exactly one end record. */
export function ndjsonReport(report, code = 0, warnings = [], options = {}) {
  const compact = compactReport(report, code, warnings, options);
  const records = compact.deltas.map((delta) => ({ type: 'delta', ...delta }));
  const end = {
    type: 'end',
    schemaVersion: compact.schemaVersion,
    detectedAt: compact.detectedAt,
    ...(compact.repos ? { repos: compact.repos } : {}),
    ...(compact.baseline !== undefined ? { baseline: compact.baseline } : {}),
    counts: compact.counts,
    ...(compact.errors !== undefined ? { errors: compact.errors } : {}),
    warnings: compact.warnings,
    exitCode: code,
  };
  return `${[...records, end].map((row) => JSON.stringify(row)).join('\n')}\n`;
}
