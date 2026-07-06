// Optional HTTP delivery edge. Detection remains authoritative even when delivery fails.
import { OUTPOST_SCHEMA_VERSION } from './contract.mjs';

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Validate and normalize an outpost destination.
 *
 * Only HTTP(S) URLs are accepted. The normalized href is returned so callers can
 * avoid logging or reparsing the original user input.
 */
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

/**
 * Return a stable class key used inside event and delivery identifiers.
 */
function classKey(delta) {
  return [...(delta.classes ?? [])].sort().join('+');
}

/**
 * Build a deterministic semantic event id for a delta event envelope.
 */
function semanticEventId(report, delta) {
  return [
    'gh-delta.delta.v1',
    report.repo,
    report.monitorId,
    delta.entity,
    String(delta.number),
    classKey(delta),
  ].join(':');
}

/**
 * Build a deterministic delivery id for a single outpost send attempt.
 */
function deliveryId(report, delta, detectedAt) {
  return [
    'gh-delta.delivery.v1',
    report.repo,
    report.monitorId,
    delta.entity,
    String(delta.number),
    classKey(delta),
    detectedAt,
  ].join(':');
}

/**
 * Build the schema v1 event sent to external outpost receivers.
 *
 * The payload contains the detector facts plus a deterministic event id for
 * downstream deduplication. It never includes endpoint secrets or request
 * configuration.
 */
export function buildOutpostPayload({ report, delta }) {
  const detectedAt = report.at ?? '';
  const to = delta.to ?? null;
  const from = delta.from ?? null;
  return {
    type: 'gh-delta.delta',
    schemaVersion: OUTPOST_SCHEMA_VERSION,
    eventId: semanticEventId(report, delta),
    deliveryId: deliveryId(report, delta, detectedAt),
    repo: report.repo,
    monitorId: report.monitorId,
    detectedAt,
    entity: delta.entity,
    number: delta.number,
    title: delta.title,
    classes: [...(delta.classes ?? [])],
    state: to?.state ?? from?.state ?? null,
    labels: to?.labels ?? from?.labels ?? [],
    line:
      delta.summaryLine ??
      delta.line ??
      `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${(delta.classes ?? []).join(', ')}`,
    delta: { from, to },
    links: {
      html: htmlLink(report.repo, delta),
    },
  };
}

/**
 * POST one already-built outpost payload.
 *
 * Network, timeout, and HTTP failures throw sanitized errors. Callers should
 * turn those into warnings so outpost delivery does not change detector exit
 * codes or trigger another snapshot write.
 */
export async function postOutpost(
  url,
  payload,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
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

/**
 * Send one outpost POST per delta and collect sanitized warning records.
 *
 * Delivery is deliberately at-most-once: no retries, no queue, and no effect on
 * the detector result.
 */
export async function sendOutposts({
  outpostUrl,
  report,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPosts = Infinity,
}) {
  const warnings = [];
  const deltas = report.deltas ?? [];
  for (const [index, delta] of deltas.entries()) {
    if (index >= maxPosts) {
      warnings.push({
        label: 'outpost',
        reason: `skipped ${deltas.length - index} delta(s) after max outpost post count ${maxPosts}`,
      });
      break;
    }
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
