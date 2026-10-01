const JSON_CONTROLS = /[\u007F-\u009F\u2028\u2029]/g;

function escapeJsonText(json) {
  return json.replace(
    JSON_CONTROLS,
    (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return escapeJsonText(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${escapeJsonText(JSON.stringify(key))}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

function warningKey(warning) {
  return canonicalJson(warning);
}

function mergeWarnings(reportWarnings, extraWarnings) {
  const counts = new Map();
  const order = [];
  for (const list of [reportWarnings, extraWarnings]) {
    const local = new Map();
    for (const warning of list ?? []) {
      const key = warningKey(warning);
      local.set(key, (local.get(key) ?? 0) + 1);
      if (!counts.has(key)) {
        counts.set(key, 0);
        order.push(warning);
      }
    }
    for (const [key, count] of local) counts.set(key, Math.max(counts.get(key) ?? 0, count));
  }
  const out = [];
  for (const warning of order) {
    const key = warningKey(warning);
    const n = counts.get(key) ?? 1;
    for (let i = 0; i < n; i++) out.push(warning);
  }
  return out;
}

function errorPayload(report) {
  const payload = {};
  const message = report.error;
  const fields = {
    kind: report.kind,
    message,
    hint: report.hint,
    repo: report.repo,
    monitorId: report.monitorId,
    resetAt: report.resetAt,
    remaining: report.remaining,
    cost: report.cost,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') payload[key] = value;
  }
  return payload;
}

function resultErrorPayload(row) {
  const err = row.error;
  const payload = {};
  const fields = {
    kind: err.kind,
    message: err.message,
    hint: err.hint,
    repo: row.repo,
    resetAt: err.resetAt,
    remaining: err.remaining,
    cost: err.cost,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') payload[key] = value;
  }
  return payload;
}

export function formatTemplateDiagnostics(report, extraWarnings = []) {
  const lines = [];
  if (report?.error) lines.push(`gh-delta: error ${canonicalJson(errorPayload(report))}`);
  for (const row of report?.results ?? []) {
    if (row.error) lines.push(`gh-delta: error ${canonicalJson(resultErrorPayload(row))}`);
  }
  for (const warning of mergeWarnings(report?.warnings, extraWarnings)) {
    lines.push(`gh-delta: warning ${canonicalJson(warning)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
