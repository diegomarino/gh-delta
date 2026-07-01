const DEFAULT_TIMEOUT_MS = 4000;

export function validateOutpostUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: '--outpost-url must be a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '--outpost-url must use http: or https:' };
  }
  return { ok: true, url: url.href };
}

function htmlLink(repo, delta) {
  const path = delta.entity === 'pr' ? 'pull' : 'issues';
  return `https://github.com/${repo}/${path}/${delta.number}`;
}

function eventId(report, delta, detectedAt) {
  return [
    'gh-delta.delta.v1',
    report.repo,
    report.branch ?? '',
    delta.entity,
    String(delta.number),
    (delta.classes ?? []).join('+'),
    detectedAt,
  ].join(':');
}

export function buildOutpostPayload({ report, delta }) {
  const detectedAt = report.at ?? '';
  const to = delta.to ?? null;
  const from = delta.from ?? null;
  return {
    type: 'gh-delta.delta',
    schemaVersion: 1,
    eventId: eventId(report, delta, detectedAt),
    repo: report.repo,
    branch: report.branch ?? null,
    detectedAt,
    entity: delta.entity,
    number: delta.number,
    title: delta.title,
    classes: [...(delta.classes ?? [])],
    state: to?.state ?? from?.state ?? null,
    labels: to?.labels ?? from?.labels ?? [],
    line: delta.line ?? `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${(delta.classes ?? []).join(', ')}`,
    delta: { from, to },
    links: {
      html: htmlLink(report.repo, delta),
    },
  };
}

export async function postOutpost(url, payload, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'error'}`);
  } catch (err) {
    if (err?.message?.startsWith('HTTP ')) throw err;
    if (err?.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms`);
    throw new Error('network failure');
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendOutposts({ outpostUrl, report, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const warnings = [];
  for (const delta of report.deltas ?? []) {
    const payload = buildOutpostPayload({ report, delta });
    try {
      await postOutpost(outpostUrl, payload, { fetchImpl, timeoutMs });
    } catch (err) {
      warnings.push({
        label: `${payload.entity.toUpperCase()} #${payload.number}`,
        reason: String(err?.message ?? err),
      });
    }
  }
  return { warnings };
}
