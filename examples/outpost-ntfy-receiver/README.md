# Outpost → ntfy receiver

The **push side** of gh-delta: instead of a consumer polling the report,
`--outpost-url` POSTs one JSON payload per delta and this small zero-dep
receiver turns each into an [ntfy](https://ntfy.sh) push notification on your
phone, with the GitHub page one tap away.

```
gh-delta tick (cron, CI, systemd — anything)      exit 10
   │  one POST per delta (payload schema v1)
   ▼
receiver.mjs :8787
   ├─ check shared secret (OUTPOST_SECRET), if configured
   ├─ validate type + schemaVersion
   ├─ dedupe by eventId (append-only, size-capped seen-events.jsonl)
   ├─ optional class filter (NTFY_CLASSES)
   ▼
ntfy.sh/<topic> ──> phone: "owner/repo PR #42 — merged"
```

## Install

```bash
NTFY_TOPIC=my-gh-deltas node receiver.mjs &
gh-delta --repo owner/repo --monitor-id push --state-dir ./state \
  --outpost-url http://127.0.0.1:8787/
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

You have two ways to secure a non-localhost deployment — pick at least one:

1. **Shared secret (`OUTPOST_SECRET`).** Set `OUTPOST_SECRET` to a random
   value and the receiver rejects any POST that doesn't present it (`401`),
   compared with `crypto.timingSafeEqual` to avoid timing side channels.
   Because the current `gh-delta --outpost-url` sender (`lib/outpost.mjs`)
   only POSTs JSON with a `Content-Type` header and cannot attach custom
   headers, the secret can be supplied either way:
   - **Header** (preferred, for a reverse proxy or a custom sender that can
     set headers): `Authorization: Bearer <secret>`.
   - **Query string** (works today with the stock `gh-delta` CLI, since
     `--outpost-url` is just a URL): append `?secret=<secret>` to the URL you
     pass to `--outpost-url`, e.g.
     `--outpost-url "http://receiver.example.com:8787/?secret=<secret>"`.
     Prefer HTTPS in front of the receiver if you use the query-string form,
     since URLs (and thus the secret) can end up in proxy/access logs
     otherwise.

   ```bash
   # Export the secret first so BOTH the receiver and the sender below see it.
   # (A command-prefix `OUTPOST_SECRET=... node receiver.mjs` would scope it to
   # the receiver only, leaving the sender's $OUTPOST_SECRET empty -> 401.)
   export OUTPOST_SECRET=$(openssl rand -hex 32)
   NTFY_TOPIC=my-gh-deltas HOST=0.0.0.0 node receiver.mjs &
   gh-delta --repo owner/repo --monitor-id push --state-dir ./state \
     --outpost-url "http://receiver.example.com:8787/?secret=$OUTPOST_SECRET"
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

`seen-events.jsonl` is capped at `SEEN_MAX_ENTRIES` entries (default 5000).
Past that cap the receiver rotates: the oldest entries are dropped in
memory and the file is rewritten with only the retained (most recent)
entries, so an unattended long-running receiver can't grow the file
without bound. Dropping an old entry only risks re-forwarding a duplicate
ntfy ping for an event that's long past — dedupe correctness for recent
events is unaffected.

## Design notes

- **Dedupe is the receiver's contractual job.** Delivery is at-most-once with
  no retries, and concurrent or re-run ticks can legitimately re-send the same
  semantic event — `eventId` is the dedupe key, `deliveryId` only names one
  attempt. See the
  [payload schema](../../docs/contract.md#outpost-payload-schema-v1).
- **Gaps are possible by design**: a failed POST is a warning in the
  detector's report, never a retry. Don't build "did I miss something?" logic
  here — the snapshot already advanced; the next delta will come.
- **Seen-before-forward**: the receiver marks an event seen before pushing to
  ntfy, mirroring the detector's at-most-once stance. Swap the order if you
  prefer duplicate pings over missed ones.
- **Always 202**: forwarding failures are logged to stderr, never turned into
  HTTP errors — the detector's tick latency must not depend on ntfy.

## Requirements

Node >= 18 (global `fetch`). No packages. An ntfy topic (free, no account) or
a self-hosted ntfy server. `gh-delta` resolves via `npx gh-delta`, or
`node <checkout>/gh-delta.mjs` from a checkout.
