// Optional HTTP delivery edge. Detection remains authoritative even when delivery fails.
import { OUTPOST_SCHEMA_VERSION } from './contract.mjs';
import { deltaId, deltaIdentity } from './fingerprint.mjs';
import { createHmac } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 4000;

/** Return the wire-format HMAC-SHA256 signature for exact request body bytes. */
export function outpostSignature(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

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
 *
 * Identity of the SERIES, not the change: it excludes both the observed `to`
 * state and the detection timestamp, so "this monitor saw this item reach this
 * class set" is stable across every repeat occurrence, by design. That makes it
 * the right key for grouping, correlating, or threading notifications about a
 * kind of change, but the wrong key for deciding whether to discard one: two
 * different observed states (e.g. CI red, then green, then red again) produce
 * the same eventId, so dedupe-by-eventId silently drops every change after the
 * first. Use `id` (content-addressed, includes the observed state) to dedupe
 * work instead.
 */
function semanticEventId(report, delta) {
  const repo = delta.repo ?? report.repo;
  return [
    'gh-delta.delta.v1',
    repo,
    report.monitorId,
    delta.entity,
    String(delta.number),
    classKey(delta),
  ].join(':');
}

/**
 * Build a deterministic delivery id for a single outpost send attempt.
 *
 * Same key as the event id plus the detection time, so it is unique per tick
 * while still reproducible. Identity of one send attempt only: useful for
 * correlating logs and transport retries, not for deduping work — it changes
 * every tick even when nothing observable changed. Receivers should dedupe
 * work by `id` (see buildOutpostPayload); eventId groups/correlates but must
 * never gate a discard, and deliveryId is narrower still.
 */
function deliveryId(report, delta, detectedAt) {
  const repo = delta.repo ?? report.repo;
  return [
    'gh-delta.delivery.v1',
    repo,
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
 * The payload contains the detector facts plus three distinct identifiers
 * (`id`, `eventId`, `deliveryId` — see their builders for what each is for).
 * It never includes endpoint secrets or request configuration.
 */
export function buildOutpostPayload({ report, delta }) {
  const detectedAt = report.at ?? '';
  const repo = delta.repo ?? report.repo;
  const to = delta.to ?? null;
  const from = delta.from ?? null;
  return {
    type: 'gh-delta.delta',
    schemaVersion: OUTPOST_SCHEMA_VERSION,
    // Content-addressed delta id (stable across runs and monitors; excludes
    // monitorId, so the same change reported by several monitors collapses to
    // one id too). This is the identity of the CHANGE, and the one field safe
    // to dedupe work by: it is derived from the observed `to` state, so a
    // repeat means the state genuinely repeated, the only case where discarding
    // is correct. eventId/deliveryId below are the SERIES and SEND-ATTEMPT
    // identities respectively — neither is safe as a dedupe key; see their
    // builder comments. The CLI stamps `delta.id` at report assembly; recompute
    // here as a fallback so the documented detectDeltas -> buildOutpostPayload
    // embedding path (which never runs the CLI report step) still emits a real
    // id, not null.
    id: delta.id ?? deltaId(deltaIdentity(repo, delta)),
    eventId: semanticEventId(report, delta),
    deliveryId: deliveryId(report, delta, detectedAt),
    repo,
    monitorId: report.monitorId,
    detectedAt,
    entity: delta.entity,
    number: delta.number,
    title: delta.title,
    // PR head branch as context (null if deleted post-merge). Mirrors the report
    // delta exactly: present only on PR deltas that have a current object
    // (`to != null`); omitted for issues and for the missing lifecycle, so a null
    // means "branch deleted", never "no current object".
    ...(delta.entity === 'pr' && delta.to != null
      ? { headRefName: delta.headRefName ?? null }
      : {}),
    classes: [...(delta.classes ?? [])],
    // Semantic summary, mirrored from the report delta. Present only when the CLI
    // ran with --summaries (which stamps delta.summary), so webhook consumers and
    // JSON-report consumers see the same optional field rather than it silently
    // vanishing on the delivery edge.
    ...(delta.summary != null ? { summary: delta.summary } : {}),
    // Transient opt-in body enrichment is mirrored exactly when present. It is
    // intentionally absent from normal/unsigned payload bytes.
    ...(delta.enrichment != null ? { enrichment: delta.enrichment } : {}),
    state: to?.state ?? from?.state ?? null,
    labels: to?.labels ?? from?.labels ?? [],
    line:
      delta.summaryLine ??
      delta.line ??
      `${delta.entity.toUpperCase()} #${delta.number} "${delta.title}": ${(delta.classes ?? []).join(', ')}`,
    delta: { from, to },
    links: {
      html: htmlLink(repo, delta),
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
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, secret } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (secret !== undefined) headers['X-GhDelta-Signature'] = outpostSignature(body, secret);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
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
  secret,
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
      await postOutpost(outpostUrl, payload, { fetchImpl, timeoutMs, secret });
    } catch (err) {
      warnings.push({
        label: `${payload.entity.toUpperCase()} #${payload.number}`,
        reason: String(err?.message ?? err),
      });
    }
  }
  return { warnings };
}
