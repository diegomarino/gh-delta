#!/usr/bin/env node
// gh-delta outpost receiver -> ntfy.sh push notifications.
//
// Receives one POST per delta (payload schema v1, see docs/contract.md),
// deduplicates by `id` (the content-addressed identity of the observed
// change — the contract's dedupe key; `eventId` identifies a series and
// repeats by design across different observed states, so it must never gate
// a discard), optionally filters by class, and forwards to an ntfy topic so
// deltas reach a phone. Zero dependencies.
//
// Env: NTFY_TOPIC (required), PORT (default 8787),
//      HOST (default 127.0.0.1; set 0.0.0.0 only if the detector runs on another machine),
//      NTFY_BASE_URL (default https://ntfy.sh; point at a self-hosted ntfy),
//      NTFY_CLASSES (comma list; empty = forward every class),
//      SEEN_FILE (default ./seen-events.jsonl),
//      SEEN_MAX_ENTRIES (default 5000; oldest entries are dropped past this cap),
//      OUTPOST_SECRET (optional shared secret; when set, every POST must carry
//        an X-GhDelta-Signature HMAC over its raw body. See README.md).
//
// SECURITY: with OUTPOST_SECRET unset, this receiver accepts and forwards any
// well-formed POST with no authentication. That is fine bound to 127.0.0.1
// (the default), but binding HOST to 0.0.0.0 or any non-loopback address
// without setting OUTPOST_SECRET turns this into an open relay that anyone
// reachable can use to spoof phone notifications. Either set OUTPOST_SECRET or
// put a reverse proxy with its own auth in front — see README.md.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Verify the exact SHA-256 HMAC over the raw request body.
 *
 */
function isAuthorized(req, rawBody, outpostSecret) {
  if (!outpostSecret) return true;
  const signature = req.headers['x-ghdelta-signature'];
  const match = typeof signature === 'string' && /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', outpostSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Seen state is one record per (entity, number) item — the LAST id forwarded
// for that item — not an append-only log of every id ever seen. `id` is
// content-addressed to the observed `to` state (see docs/contract.md's
// `deltaIdentity`), so an item that returns to a previously observed state
// (e.g. CI red -> green -> red with nothing else on the fingerprint changed)
// legitimately repeats a prior `id`. Comparing only against the most recent
// id per item forwards that recurrence correctly, while still collapsing the
// case `id` exists to collapse: two monitors reporting the same observed
// change emit the same `id` (it excludes `monitorId`), and those arrive
// adjacently, so the second is suppressed.
//
// The file persists one JSON line per record:
// `{"key":"pr#42","id":"<sha>","at":"<iso>"}`. Loading replays the file in
// order into a Map, so the last line written for a given key wins — this
// keeps the existing "append, then rewrite when capped" shape instead of
// rewriting the file on every request.

function itemKey(payload) {
  return `${payload.entity}#${payload.number}`;
}

/**
 * Parse one seen-file line into a `{ key, id }` record, or `null` if the
 * line is unusable.
 *
 * Migration note: earlier versions of this receiver recorded `{ eventId, at }`
 * per line (pre-branch, dedup'd by the wrong field), and a mid-review revision
 * of this branch recorded `{ id, at }` with no item key at all. Neither old
 * shape carries the `key` this format needs, and there is no way to recover
 * it after the fact, so a line missing `key` or `id` is skipped and that item
 * is treated as unseen. That is the safe direction to fail: a receiver
 * restarted right after this upgrade may re-forward a handful of
 * already-seen deltas once, a harmless duplicate ping — never the silent,
 * permanent data loss the `id`-based dedupe fix (and this per-item scoping)
 * exists to prevent.
 */
function parseSeenLine(line) {
  if (!line) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null; // corrupt line; losing one dedupe entry only risks a repeat ping
  }
  const { key, id } = record ?? {};
  if (!key || !id) return null; // old-format line; see migration note above
  return { key, id };
}

/**
 * Replay a seen-file's full text into `{ seen, seenOrder }`.
 *
 * `seen` maps item key -> last forwarded id. `seenOrder` lists keys in
 * first-seen order, used for FIFO eviction when the item count exceeds the
 * cap. Pure: takes file text in, returns state out, no I/O.
 */
function loadSeenState(text) {
  const seen = new Map();
  const seenOrder = [];
  for (const line of text.split('\n')) {
    const record = parseSeenLine(line);
    if (!record) continue;
    if (!seen.has(record.key)) seenOrder.push(record.key);
    seen.set(record.key, record.id);
  }
  return { seen, seenOrder };
}

/**
 * Pure dedupe + class-filter decision for one payload.
 *
 * The class filter is applied BEFORE the seen check, and a filtered-out
 * payload's id is never recorded. This matters because `id` excludes
 * `monitorId` and, for deltas with an observed `to` state, excludes
 * `classes` too — so two monitors can observe the same final state via
 * different transitions and emit the same `id` with different class sets.
 * Filtering first (and only ever recording ids that actually pass and get
 * forwarded) means a payload whose classes don't match NTFY_CLASSES can
 * never poison the seen state against a later payload that shares its `id`
 * but carries an allowed class.
 *
 * Returns `{ action, key }`: `action` is `'filtered'`, `'deduped'`, or
 * `'forward'`; `key` is the item key to record, present only when
 * `action === 'forward'`.
 */
function shouldForward(seenMap, payload, classes) {
  if (classes.length && !payload.classes?.some((cls) => classes.includes(cls))) {
    return { action: 'filtered', key: null };
  }
  const key = itemKey(payload);
  if (seenMap.get(key) === payload.id) {
    return { action: 'deduped', key: null };
  }
  return { action: 'forward', key };
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function forward(payload, ntfyBaseUrl, ntfyTopic) {
  const response = await globalThis.fetch(`${ntfyBaseUrl}/${ntfyTopic}`, {
    method: 'POST',
    headers: {
      Title: `${payload.repo} ${payload.entity.toUpperCase()} #${payload.number}`,
      Click: payload.links?.html ?? '',
    },
    body: payload.line,
  });
  if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
}

/** Build the HTTP boundary with injectable state/forwarding for local testing. */
function createReceiverHandler({
  outpostSecret,
  classes,
  seen,
  recordSeen,
  forward: forwardPayload,
}) {
  return (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: 'POST only' });
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      if (!isAuthorized(req, rawBody, outpostSecret))
        return respond(res, 401, { error: 'unauthorized' });
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return respond(res, 400, { error: 'invalid JSON' });
      }
      if (payload?.type !== 'gh-delta.delta' || payload?.schemaVersion !== 1) {
        return respond(res, 400, { error: 'expected gh-delta.delta schemaVersion 1' });
      }
      const decision = shouldForward(seen, payload, classes);
      if (decision.action === 'filtered') return respond(res, 202, { filtered: true });
      if (decision.action === 'deduped') return respond(res, 202, { deduped: true });
      recordSeen(decision.key, payload.id, payload.detectedAt);
      respond(res, 202, { accepted: true });
      forwardPayload(payload).catch((err) =>
        console.error(`receiver: ntfy forward failed for ${payload.id}: ${err.message}`),
      );
    });
  };
}

function main() {
  const PORT = Number(process.env.PORT ?? 8787);
  const HOST = process.env.HOST ?? '127.0.0.1';
  const NTFY_TOPIC = process.env.NTFY_TOPIC;
  const NTFY_BASE_URL = process.env.NTFY_BASE_URL ?? 'https://ntfy.sh';
  const SEEN_FILE = process.env.SEEN_FILE ?? './seen-events.jsonl';
  const SEEN_MAX_ENTRIES = Number(process.env.SEEN_MAX_ENTRIES ?? 5000);
  const OUTPOST_SECRET = process.env.OUTPOST_SECRET ?? '';
  const CLASSES = (process.env.NTFY_CLASSES ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  if (!NTFY_TOPIC) {
    console.error('receiver: NTFY_TOPIC is required');
    process.exit(1);
  }

  if (!OUTPOST_SECRET && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.error(
      `receiver: WARNING: HOST=${HOST} with no OUTPOST_SECRET set. ` +
        'This receiver has no authentication and will accept POSTs from anyone ' +
        'who can reach this port, letting them spoof phone notifications. Set ' +
        'OUTPOST_SECRET or put an authenticating reverse proxy in front. See README.md.',
    );
  }

  let { seen, seenOrder } = existsSync(SEEN_FILE)
    ? loadSeenState(readFileSync(SEEN_FILE, 'utf8'))
    : { seen: new Map(), seenOrder: [] };

  function rewriteSeenFile() {
    writeFileSync(
      SEEN_FILE,
      seenOrder.map((key) => `${JSON.stringify({ key, id: seen.get(key) })}\n`).join(''),
    );
  }

  if (seenOrder.length > SEEN_MAX_ENTRIES) {
    for (const dropped of seenOrder.slice(0, seenOrder.length - SEEN_MAX_ENTRIES)) {
      seen.delete(dropped);
    }
    seenOrder = seenOrder.slice(-SEEN_MAX_ENTRIES);
    rewriteSeenFile();
  }

  // The cap is applied per distinct item (Map/seenOrder size), not per
  // delivery recorded — a long-lived item that keeps changing state costs
  // one slot, not one slot per change.
  function recordSeen(key, id, detectedAt) {
    if (!seen.has(key)) seenOrder.push(key);
    seen.set(key, id);
    if (seenOrder.length > SEEN_MAX_ENTRIES) {
      // Rotate: drop the oldest item from memory and rewrite the file rather
      // than letting it grow forever. Rewriting on every rotation keeps the
      // implementation simple; at SEEN_MAX_ENTRIES's default this is a rare,
      // small write, not a per-request cost.
      const dropped = seenOrder.shift();
      seen.delete(dropped);
      rewriteSeenFile();
      return;
    }
    appendFileSync(SEEN_FILE, `${JSON.stringify({ key, id, at: detectedAt })}\n`);
  }

  const server = createServer(
    createReceiverHandler({
      outpostSecret: OUTPOST_SECRET,
      classes: CLASSES,
      seen,
      recordSeen,
      forward: (payload) => forward(payload, NTFY_BASE_URL, NTFY_TOPIC),
    }),
  );

  server.listen(PORT, HOST, () =>
    console.log(`gh-delta outpost receiver on ${HOST}:${PORT} -> ${NTFY_BASE_URL}/${NTFY_TOPIC}`),
  );
}

// Run the server only when this file is executed directly (`node receiver.mjs`
// or via the shebang), not when it's imported — tests import this module to
// unit-test the pure dedupe/filter/parsing functions above without starting
// an HTTP server or requiring NTFY_TOPIC to be set.
//
// Compare real paths, not a hand-built `file://` + argv[1] string: import.meta.url
// is percent-encoded, so a receiver living under a path with a space (or any
// non-ASCII character) would never match, and a symlinked invocation would not
// either. Both cases fail the same silent way — the process exits 0 having
// started no server, which for a notification receiver looks exactly like
// working. Same reasoning as lib/entrypoint.mjs in this repo; inlined here so
// the example stays a single copyable file.
function isDirectlyExecuted() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const here = new URL(import.meta.url).pathname;
  try {
    return realpathSync(here) === realpathSync(invoked);
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}

if (isDirectlyExecuted()) {
  main();
}

export {
  itemKey,
  parseSeenLine,
  loadSeenState,
  shouldForward,
  isAuthorized,
  createReceiverHandler,
};
