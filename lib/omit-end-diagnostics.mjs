function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => sortedJson(item) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const encoded = sortedJson(value[key]);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value) {
  return sortedJson(value).replace(/[\u007F\u0080-\u009F\u2028\u2029]/g, (ch) => {
    return `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`;
  });
}

function bareError(report) {
  if (!report?.error) return [];
  return [
    {
      ...(report.repo ? { repo: report.repo } : {}),
      kind: report.kind,
      message: report.error,
      hint: report.hint,
      ...(report.resetAt ? { resetAt: report.resetAt } : {}),
      ...(report.remaining !== undefined ? { remaining: report.remaining } : {}),
      ...(report.cost !== undefined && report.cost !== null ? { cost: report.cost } : {}),
    },
  ];
}

function envelopedErrors(report) {
  if (!Array.isArray(report?.results)) return [];
  return report.results.filter((row) => row.error).map((row) => ({ repo: row.repo, ...row.error }));
}

function takeMax(primary, secondary) {
  const remaining = new Map();
  for (const item of primary) {
    const key = canonicalJson(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const warnings = [...primary];
  for (const item of secondary) {
    const key = canonicalJson(item);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else warnings.push(item);
  }
  return warnings;
}

export function formatOmitEndDiagnostics(report, resultWarnings = []) {
  const errors = bareError(report).length ? bareError(report) : envelopedErrors(report);
  const warnings = takeMax(report?.warnings ?? [], resultWarnings ?? []);
  const lines = [
    ...errors.map((error) => `gh-delta: error ${canonicalJson(error)}`),
    ...warnings.map((warning) => `gh-delta: warning ${canonicalJson(warning)}`),
  ];
  return lines.length ? `${lines.join('\n')}\n` : '';
}
