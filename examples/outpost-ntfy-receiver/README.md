# Outpost → ntfy receiver

The **push side** of gh-delta: instead of a consumer polling the report,
`--outpost-url` POSTs one JSON payload per delta and this ~100-line zero-dep
receiver turns each into an [ntfy](https://ntfy.sh) push notification on your
phone, with the GitHub page one tap away.

```
gh-delta tick (cron, CI, systemd — anything)      exit 10
   │  one POST per delta (payload schema v1)
   ▼
receiver.mjs :8787
   ├─ validate type + schemaVersion
   ├─ dedupe by eventId (append-only seen-events.jsonl)
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
a self-hosted ntfy server. `gh-delta` resolves via `npx gh-delta` once published, or `node <checkout>/gh-delta.mjs` from a checkout.
