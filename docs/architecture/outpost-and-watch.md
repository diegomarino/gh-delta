# Outpost Edge

[Documentation](../README.md) · [Architecture by responsibility](../architecture.md)

`--outpost-url` is an optional edge on `gh-delta.mjs`. `--outpost-secret` may
opt it into HMAC-SHA256 request-body signatures using a named environment
variable; the resolved secret stays on the delivery path and never enters the
report. It is not part of
`lib/detect.mjs`; the detector still only returns facts.

The outpost path is deliberately small: validate the endpoint and secret
configuration, serialize/sign/send one payload
per delta after a successful detection, collect warnings, and leave the detector
exit result unchanged. Authentication, retry policy, durable queues, endpoint
filtering, dedupe, and action execution belong downstream.

The exact payload envelope and event identity semantics are specified in
[Outpost Payload](../contract/outpost.md#outpost-payload-schema-v2).

## Future Entity and Selector Research

## I-6 watch selection and economical polling

Watch files are monitor-private local JSON state and are validated before a
GitHub fetch. An explicit `--watch-dir` whose `--entities` selection includes
PRs and contains zero to ten PR entries routes through `fetchPRsByNumber`: one
aliased `pullRequest(number:)` GraphQL request
shares the broad PR selection and normalizer, while an empty watch list avoids
GitHub entirely. The targeted universe has its own `__watch-pr.json` (or
`.watch.json` explicit-file sibling), so its lock, delta log, registry record,
report and snapshot never collide with broad polling. Before detection, old
targeted state is projected to current membership: removal is silent, but a
still-watched null alias follows the ordinary missing lifecycle. Without
`--watch-strict`, lists with an issue, over ten entries, or `--entities issue`
retain broad repository fetches. `--watch-strict` batches any supported
membership by ten and, for issues, uses `repository.issue(number:)` plus
`normalizeIssue`. Issue-only state is `__watch-issue.json`; a mixed list that
contains an issue is `__watch-pr-issue.json`. Neither replaces `watch-pr` or a
poll snapshot. Terminal cleanup compares bytes read at tick start before
unlinking after snapshot publication.

The public contract currently supports only `pr`, `issue`, and `pr,issue`.
Research notes under `docs/entities-research/` inventory future entities and
selector applicability. A selector such as `branch` must be validated per entity
before it becomes public; for example, branch selectors can apply to commits or
workflow runs, but not to issues.
