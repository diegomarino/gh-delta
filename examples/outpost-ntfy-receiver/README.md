# Outpost → ntfy receiver

The **push side** of gh-delta: instead of a consumer polling the report,
`--outpost-url` POSTs one JSON payload per delta and this small zero-dep
receiver turns each into an [ntfy](https://ntfy.sh) push notification on your
phone, with the GitHub page one tap away.

```
gh-delta tick (cron, CI, systemd — anything)      exit 10
   │  one POST per delta ({type, schemaVersion, deliveryId, seq, monitorId, detectedAt, delta})
   ▼
receiver.mjs :8787
   ├─ verify Standard Webhooks signature (OUTPOST_SECRET), if configured
   ├─ validate type + schemaVersion
   ├─ optional class filter (NTFY_CLASSES)
   ├─ dedupe by delta.id, scoped to the most recent id per item (size-capped seen-events.jsonl)
   ▼
ntfy.sh/<topic> ──> phone: "owner/repo PR #42 — merged"
```

## Install

```bash
export OUTPOST_SECRET=$(openssl rand -hex 32)
NTFY_TOPIC=my-gh-deltas node receiver.mjs &
gh-delta --repo owner/repo --monitor-id push --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --outpost-url http://127.0.0.1:8787/ --outpost-secret OUTPOST_SECRET
```

Subscribe to the topic in the ntfy app. `NTFY_CLASSES=merged,ci-changed`
narrows pings to the classes you care about;
`NTFY_BASE_URL=https://ntfy.example.com` targets a self-hosted server.

## Security: authenticating requests

By default the receiver accepts any well-formed POST with **no
authentication**. That's a reasonable default when it's bound to
`127.0.0.1` (the default `HOST`) — only processes on the same machine can
reach it. It stops being reasonable the moment `HOST` is anything else: an
unauthenticated receiver reachable over a network is an open relay that
anyone who can reach the port can use to spoof phone notifications, and it
will log a loud warning to stderr on startup if you do this without a
secret configured.

The receiver accepts request bodies up to 64 KiB. Larger requests return HTTP
413 before authentication, JSON parsing, dedupe, recording, or forwarding.

You have two ways to secure a non-localhost deployment — pick at least one:

1. **Shared secret (`OUTPOST_SECRET`).** Set `OUTPOST_SECRET` to a random
   value. The receiver verifies each request per the
   [Standard Webhooks](https://www.standardwebhooks.com/) spec: `webhook-id`
   (the delivery id), `webhook-timestamp` (epoch seconds, rejected if more
   than 5 minutes from now — replay protection), and `webhook-signature`
   (`v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{rawBody}">`), compared with
   `crypto.timingSafeEqual` before it parses, dedupes, records, or forwards
   the payload. The stock sender reads the same environment value by name;
   the secret never appears in a URL or command argument.

   ```bash
   # Export the secret first so BOTH the receiver and the sender below see it.
   # (A command-prefix `OUTPOST_SECRET=... node receiver.mjs` would scope it to
   # the receiver only, leaving the sender's $OUTPOST_SECRET empty -> 401.)
   export OUTPOST_SECRET=$(openssl rand -hex 32)
   NTFY_TOPIC=my-gh-deltas HOST=0.0.0.0 node receiver.mjs &
   gh-delta --repo owner/repo --monitor-id push --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
     --outpost-url "http://receiver.example.com:8787/" \
     --outpost-secret OUTPOST_SECRET
   ```

2. **Reverse proxy.** Put the receiver behind a proxy (nginx, Caddy,
   Cloudflare Tunnel, Tailscale, etc.) that terminates TLS and enforces its
   own authentication (mTLS, basic auth, an allowlist of source IPs/network),
   and keep `HOST=127.0.0.1` so the receiver itself is only reachable through
   the proxy. This is the stronger option if you also want TLS in transit,
   since the receiver itself speaks plain HTTP.

If you bind non-locally with neither of the above, you are running an open
relay — do that only on a network you fully trust.

## SEEN_FILE growth

`seen-events.jsonl` holds one record per `(entity, number)` item —
`{"key":"pr#42","id":"<sha>","at":"<iso>"}` — not one record per delivery.
It's capped at `SEEN_MAX_ENTRIES` **items** (default 5000). Past that cap the
receiver rotates: the oldest items are dropped in memory and the file is
rewritten with only the retained (most recently added) items, so an
unattended long-running receiver can't grow the file without bound. Dropping
an old item only risks re-forwarding a duplicate ntfy ping if that exact item
resurfaces later — dedupe correctness for recently active items is
unaffected.

Upgrading from an older receiver: earlier versions wrote `{eventId}` or
`{id}` lines with no item key. Those lines are skipped on load (treated as
unseen) since there's no key to recover them by — expect a handful of
harmless duplicate pings right after the upgrade, never a missed one.

## Design notes

- **Dedupe is the receiver's contractual job, and `delta.id` is the key —
  scoped to the most recent id per item.** Delivery is at-most-once with no
  retries, and concurrent or re-run ticks can legitimately re-send the same
  observed change — `delta.id` (content-addressed, built from the observed
  state) is the dedupe key. But `delta.id` identifies the **state**, not
  "this occurrence": an item that returns to a state it was in before (CI
  red, then green, then red again with nothing else changed) legitimately
  repeats an earlier id, so the receiver tracks only the **last id forwarded
  per `(entity, number)`** and suppresses a payload only when it matches that
  last id — a recurrence after an intervening different state has a
  different "last id" and is correctly forwarded, while two monitors
  reporting the same observed change (which share a `delta.id`, since it
  excludes `monitorId`) still collapse when they arrive adjacently.
  `deliveryId` names one send attempt (useful for processing idempotency on
  transport retries) and is stable-per-attempt only — it must never be used
  to discard a payload; see the
  [payload schema](../../docs/contract.md#outpost-payload-schema-v2).
- **Filter before you record.** `delta.id` also excludes `classes` whenever
  there's an observed `to` state, so two monitors with different snapshot
  histories can reach the same final state through different transitions and
  emit the _same_ id with _different_ class sets. The receiver therefore
  applies `NTFY_CLASSES` first and only records an id for a payload that
  actually passes the filter and gets forwarded — recording a filtered-out
  payload's id would let it silently suppress a later, allowed payload that
  happens to share that id.
- **Gaps are possible by design**: a failed POST is a warning in the
  detector's report, never a retry. Don't build "did I miss something?" logic
  here — the snapshot already advanced; the next delta will come.
- **Seen-before-forward**: the receiver marks an item's `id` seen before
  pushing to ntfy, mirroring the detector's at-most-once stance — but only
  for a payload that already passed the class filter, so a filtered-out
  payload's id is never recorded. Swap the seen/forward order if you prefer
  duplicate pings over missed ones.
- **Always 202**: forwarding failures are logged to stderr, never turned into
  HTTP errors — the detector's tick latency must not depend on ntfy.

## Requirements

Node >= 18 (global `fetch`). No packages. An ntfy topic (free, no account) or
a self-hosted ntfy server. `gh-delta` resolves via `npx gh-delta`, or
`node <checkout>/gh-delta.mjs` from a checkout.
