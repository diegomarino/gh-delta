# Outpost Mode

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

`--outpost-url` must be an `http:` or `https:` URL. Invalid configuration exits
`2` (permanent) before GitHub is fetched.

When the detector exits `10`, `gh-delta` sends one JSON `POST` per delta with
`Content-Type: application/json`. It does not POST on exit `0`, `1`, or `2`.
POST failure, timeout, DNS failure, `4xx`, or `5xx` prints an `outpost warning`
but does not change the detector result.

Payloads use schema v2: see [Outpost Payload](../contract/outpost.md#outpost-payload-schema-v2) for the full envelope.

Outpost is best-effort notification. `gh-delta` does not emit an `eventId` —
dedupe on `deliveryId` for delivery/processing idempotency (it changes every
tick, even for the same observed change) and on `delta.id` (compare against
the last id seen per item) to collapse the same observed change reported by
more than one monitor. `gh-delta` does not provide reliable delivery, retries,
an outbox, acknowledgement, or replay. The endpoint owns filtering,
deduplication, and any downstream action. Do not put secrets in the outpost
URL.

Pass `--outpost-secret <ENV_VAR_NAME>` (naming, never containing, the
environment variable that holds the shared HMAC secret) to sign each POST per
the [Standard Webhooks](https://www.standardwebhooks.com/) spec: `webhook-id`
(the payload's `deliveryId`), `webhook-timestamp` (epoch **seconds**), and
`webhook-signature: v1,<base64 HMAC-SHA256("{id}.{timestamp}.{body}")>`.
Verify the signature and reject stale timestamps before trusting a payload.
