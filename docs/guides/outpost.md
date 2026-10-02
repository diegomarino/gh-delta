# Outpost Delivery

[Documentation](../README.md) · [Usage by task](../usage.md)

Add `--outpost-url` when you want an external endpoint to receive one
notification per delta:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr \
  --format text \
  --outpost-url https://example.com/gh-delta \
  --outpost-secret OUTPOST_SECRET
```

Outposts are best-effort notifications. The detector snapshot advances before
delivery is attempted, and downstream systems own filtering, dedupe, retries,
queues, and actions. Keep scheduler logs or add an external queue if you need
at-least-once action delivery.

`--outpost-secret` takes the name of an environment variable, not the secret
itself. When set, gh-delta signs each request per the
[Standard Webhooks](https://www.standardwebhooks.com/) spec: `webhook-id`
(the delivery id), `webhook-timestamp` (epoch seconds), and
`webhook-signature` (`v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`).
Use the same `OUTPOST_SECRET` value at the receiver. Dedupe by `deliveryId`
for processing idempotency, and by `delta.id` (the content-addressed identity
of the observed change) to collapse duplicates reported by several monitors.

The exact payload and warning semantics are specified
in [Outpost Payload](../contract/outpost.md#outpost-payload-schema-v2).

Worked receiver:
[examples/outpost-ntfy-receiver/](https://github.com/diegomarino/gh-delta/tree/main/examples/outpost-ntfy-receiver)
in the source repository.
