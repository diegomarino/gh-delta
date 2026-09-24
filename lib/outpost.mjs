// Optional HTTP delivery edge. Detection remains authoritative even when delivery fails.
import { OUTPOST_SCHEMA_VERSION } from './contract.mjs';
import { deltaId, deltaIdentity } from './fingerprint.mjs';
import { createHmac } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Return the Standard Webhooks v1 signature for one delivery attempt:
 * `v1,<base64 HMAC-SHA256("{id}.{timestamp}.{body}")>` -- see
 * https://www.standardwebhooks.com/. `timestamp` must be epoch SECONDS (not
 * ms) and the same value sent in the `webhook-timestamp` header, or a
 * spec-conformant receiver will reject the signature.
 */
export function outpostSignature(id, timestamp, body, secret) {
  const signedContent = `${id}.${timestamp}.${body}`;
  return `v1,${createHmac('sha256', secret).update(signedContent, 'utf8').digest('base64')}`;
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

/**
 * Return a stable class key used inside the delivery identifier.
 */
function classKey(delta) {
  return [...(delta.classes ?? [])].sort().join('+');
}

/**
 * Build a deterministic delivery id for a single outpost send attempt.
 *
 * Identity of one send attempt only: useful for correlating logs, transport
 * retries, and processing idempotency at the receiver -- not for deduping
 * work. It changes every tick even when nothing observable changed, so
 * receivers must dedupe work by `delta.id` (the content-addressed identity of
 * the observed change), never by `deliveryId`.
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
 * Build the schema v2 event sent to external outpost receivers.
 *
 * The payload is an envelope around the delta verbatim from the report --
 * no root-level field duplication. `deliveryId` identifies this one send
 * attempt (processing idempotency); `delta.id` is the only content
 * identifier and the correct key to dedupe work by (see deliveryId above).
 * The payload never includes endpoint secrets or request configuration.
 */
export function buildOutpostPayload({ report, delta }) {
  const detectedAt = report.detectedAt ?? '';
  const repo = delta.repo ?? report.repo;
  // The CLI stamps `delta.id` at report assembly; recompute here as a
  // fallback so the documented detectDeltas -> buildOutpostPayload embedding
  // path (which never runs the CLI report step) still emits a real id, not
  // undefined.
  const id = delta.id ?? deltaId(deltaIdentity(repo, delta));
  return {
    type: 'gh-delta.delta',
    schemaVersion: OUTPOST_SCHEMA_VERSION,
    deliveryId: deliveryId(report, delta, detectedAt),
    // Journal record number for this delta when the run used --log, else
    // null (not omitted -- a receiver storing this payload should not have
    // to distinguish "no log" from "field absent").
    seq: delta.seq ?? null,
    monitorId: report.monitorId,
    detectedAt,
    delta: delta.id != null ? delta : { ...delta, id },
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
    if (secret !== undefined) {
      // Epoch seconds, per the Standard Webhooks spec -- not milliseconds.
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers['webhook-id'] = payload.deliveryId;
      headers['webhook-timestamp'] = timestamp;
      headers['webhook-signature'] = outpostSignature(payload.deliveryId, timestamp, body, secret);
    }
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
  const aggregate = (report.repos?.length ?? 1) > 1;
  for (const [index, delta] of deltas.entries()) {
    if (index >= maxPosts) {
      if (!aggregate) {
        warnings.push({
          label: 'outpost',
          reason: `skipped ${deltas.length - index} delta(s) after max outpost post count ${maxPosts}`,
        });
      } else {
        const skipped = new Map();
        for (const remaining of deltas.slice(index)) {
          const repo = remaining.repo;
          skipped.set(repo, (skipped.get(repo) ?? 0) + 1);
        }
        for (const [repo, count] of skipped) {
          warnings.push({
            label: `${repo}: outpost`,
            reason: `skipped ${count} delta(s) after max outpost post count ${maxPosts}`,
          });
        }
      }
      break;
    }
    const payload = buildOutpostPayload({ report, delta });
    try {
      await postOutpost(outpostUrl, payload, { fetchImpl, timeoutMs, secret });
    } catch (err) {
      warnings.push({
        label: `${aggregate ? `${payload.delta.repo}: ` : ''}${payload.delta.entity.toUpperCase()} #${payload.delta.number}`,
        reason: String(err?.message ?? err),
      });
    }
  }
  return { warnings };
}
