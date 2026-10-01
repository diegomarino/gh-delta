# Scheduled NDJSON without end records

A scheduler that hashes `(exit code, stdout, stderr)` can use detector-only
`--omit-end` so a quiet successful tick is `(0, "", "")`. Do not grep `end`
out of the stream and do not wrap the detector with `|| true`.

```sh
gh-delta --repo owner/repo --monitor-id scheduled --entities pr \
  --state-dir ./state --format ndjson --omit-end
```

Equivalent project config:

```json
{ "format": "ndjson", "omit-end": true }
```

If an external wrapper first runs atomic watch sync (`watch sync`), capture
that command's report and exit status separately before this detector tick.
`--omit-end` does not suppress sync output.

An event tick followed by a quiet tick still changes a hash that includes the
exit code and the output. This flag cannot promise that the scheduler
suppresses that transition.
