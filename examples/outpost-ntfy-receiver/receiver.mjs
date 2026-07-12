#!/usr/bin/env node
// gh-delta outpost receiver -> ntfy.sh push notifications.
//
// Receives one POST per delta (payload schema v1, see docs/contract.md),
// deduplicates by eventId (the contract makes that the receiver's job),
// optionally filters by class, and forwards to an ntfy topic so deltas
// reach a phone. Zero dependencies.
//
// Env: NTFY_TOPIC (required), PORT (default 8787),
//      HOST (default 127.0.0.1; set 0.0.0.0 only if the detector runs on another machine),
//      NTFY_BASE_URL (default https://ntfy.sh; point at a self-hosted ntfy),
//      NTFY_CLASSES (comma list; empty = forward every class),
//      SEEN_FILE (default ./seen-events.jsonl),
//      SEEN_MAX_ENTRIES (default 5000; oldest entries are dropped past this cap),
//      OUTPOST_SECRET (optional shared secret; when set, every POST must present
//        it, either as `Authorization: Bearer <secret>` or `?secret=<secret>` on
//        the request URL — the query form exists because the current gh-delta
//        `--outpost-url` sender cannot attach custom headers, only a URL. See
//        README.md for how to wire this up on both sides).
//
// SECURITY: with OUTPOST_SECRET unset, this receiver accepts and forwards any
// well-formed POST with no authentication. That is fine bound to 127.0.0.1
// (the default), but binding HOST to 0.0.0.0 or any non-loopback address
// without setting OUTPOST_SECRET turns this into an open relay that anyone
// reachable can use to spoof phone notifications. Either set OUTPOST_SECRET or
// put a reverse proxy with its own auth in front — see README.md.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

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

/**
 * Constant-time compare of two secrets of possibly-different length.
 *
 * timingSafeEqual throws on length mismatch, so that case is short-circuited
 * separately. The length check itself is not timing-sensitive — the secret's
 * length isn't confidential the way its content is — only the byte-by-byte
 * comparison needs to run in constant time.
 */
function secretsMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(req, url) {
  if (!OUTPOST_SECRET) return true;
  const authHeader = req.headers['authorization'] ?? '';
  const bearerMatch = /^Bearer (.+)$/.exec(authHeader);
  if (bearerMatch && secretsMatch(bearerMatch[1], OUTPOST_SECRET)) return true;
  const querySecret = url.searchParams.get('secret') ?? '';
  if (querySecret && secretsMatch(querySecret, OUTPOST_SECRET)) return true;
  return false;
}

// eventId dedupe survives restarts through an append-only JSONL file. The
// file is capped at SEEN_MAX_ENTRIES entries so an unattended receiver can't
// grow it without bound; oldest entries are dropped first (FIFO), which only
// risks a repeat ping for very old events long after they stopped mattering.
let seenOrder = [];
const seen = new Set();
if (existsSync(SEEN_FILE)) {
  for (const line of readFileSync(SEEN_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const eventId = JSON.parse(line).eventId;
      if (!seen.has(eventId)) seenOrder.push(eventId);
      seen.add(eventId);
    } catch {
      // skip a corrupt line; losing one dedupe entry only risks a repeat ping
    }
  }
  if (seenOrder.length > SEEN_MAX_ENTRIES) {
    for (const dropped of seenOrder.slice(0, seenOrder.length - SEEN_MAX_ENTRIES)) {
      seen.delete(dropped);
    }
    seenOrder = seenOrder.slice(-SEEN_MAX_ENTRIES);
    rewriteSeenFile();
  }
}

function rewriteSeenFile() {
  writeFileSync(SEEN_FILE, seenOrder.map((eventId) => `${JSON.stringify({ eventId })}\n`).join(''));
}

function recordSeen(eventId, detectedAt) {
  seen.add(eventId);
  seenOrder.push(eventId);
  if (seenOrder.length > SEEN_MAX_ENTRIES) {
    // Rotate: drop the oldest entry from memory and rewrite the file rather
    // than letting it grow forever. Rewriting on every rotation keeps the
    // implementation simple; at SEEN_MAX_ENTRIES's default this is a rare,
    // small write, not a per-request cost.
    seen.delete(seenOrder.shift());
    rewriteSeenFile();
    return;
  }
  appendFileSync(SEEN_FILE, `${JSON.stringify({ eventId, at: detectedAt })}\n`);
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function forward(payload) {
  const response = await globalThis.fetch(`${NTFY_BASE_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: `${payload.repo} ${payload.entity.toUpperCase()} #${payload.number}`,
      Click: payload.links?.html ?? '',
    },
    body: payload.line,
  });
  if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') return respond(res, 405, { error: 'POST only' });
  // req.headers.host is client-controlled; a malformed value makes new URL()
  // throw synchronously, which would crash the process on an exposed bind.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return respond(res, 400, { error: 'invalid request URL or Host header' });
  }
  if (!isAuthorized(req, url)) return respond(res, 401, { error: 'unauthorized' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return respond(res, 400, { error: 'invalid JSON' });
    }
    if (payload?.type !== 'gh-delta.delta' || payload?.schemaVersion !== 1) {
      return respond(res, 400, { error: 'expected gh-delta.delta schemaVersion 1' });
    }
    if (seen.has(payload.eventId)) return respond(res, 202, { deduped: true });
    // Mark seen BEFORE forwarding: this mirrors the detector's at-most-once
    // stance (a failed ntfy push is logged, never retried). Move this after
    // forward() if you prefer at-least-once pings at the cost of duplicates.
    recordSeen(payload.eventId, payload.detectedAt);
    if (CLASSES.length && !payload.classes?.some((cls) => CLASSES.includes(cls))) {
      return respond(res, 202, { filtered: true });
    }
    respond(res, 202, { accepted: true });
    forward(payload).catch((err) =>
      console.error(`receiver: ntfy forward failed for ${payload.eventId}: ${err.message}`),
    );
  });
});

server.listen(PORT, HOST, () =>
  console.log(`gh-delta outpost receiver on ${HOST}:${PORT} -> ${NTFY_BASE_URL}/${NTFY_TOPIC}`),
);
