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
//      SEEN_FILE (default ./seen-events.jsonl).
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = process.env.NTFY_BASE_URL ?? 'https://ntfy.sh';
const SEEN_FILE = process.env.SEEN_FILE ?? './seen-events.jsonl';
const CLASSES = (process.env.NTFY_CLASSES ?? '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

if (!NTFY_TOPIC) {
  console.error('receiver: NTFY_TOPIC is required');
  process.exit(1);
}

// eventId dedupe survives restarts through an append-only JSONL file.
const seen = new Set();
if (existsSync(SEEN_FILE)) {
  for (const line of readFileSync(SEEN_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      seen.add(JSON.parse(line).eventId);
    } catch {
      // skip a corrupt line; losing one dedupe entry only risks a repeat ping
    }
  }
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
    seen.add(payload.eventId);
    appendFileSync(
      SEEN_FILE,
      `${JSON.stringify({ eventId: payload.eventId, at: payload.detectedAt })}\n`,
    );
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
