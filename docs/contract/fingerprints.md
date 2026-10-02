# Fingerprint fields (`from` / `to`)

[Documentation](../README.md) · [Contract reference](../contract.md)

`from`/`to` on a delta are the **bare compared fingerprint** — not the full
`{fingerprint, context, meta}` snapshot item that the _snapshot_ stores each
item as internally (see [Snapshot Semantics](snapshots.md#snapshot-semantics)). `context`
is never duplicated under `from`/`to`: it already lives at the delta's own
top level (see the `context` bullet in [Delta fields](delta-fields.md)), and
`meta` is detector bookkeeping (`seenAt`, `ticksSinceChange`, …) that is
never part of the public delta contract at all. The fingerprint itself is
**fully legible**: every key is a directly readable, already-normalized value
(lowercase enums, flat arrays) — schema v2 has no opaque digests. Prefer
`classes` as the semantic diff — the fingerprint exists mainly to read
concrete current values and for context. The field **set is additive**;
consumers must tolerate new keys and must not assume a closed shape. There is
no drop-list: every key on the fingerprint object is compared and
participates in the delta id — `delta.id` hashes exactly `to` (or `from` on
the missing lifecycle), so `to`/`from` here are precisely what the id is a
hash of.

PR fingerprint (built by `prFingerprint` from the already-normalized PR row —
see `gh-delta/fingerprint`):

| Field                  | Notes                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                | `open` \| `closed` \| `merged`.                                                                                                                                                                                                                                                                                                                             |
| `updatedAt`            | ISO-8601.                                                                                                                                                                                                                                                                                                                                                   |
| `isDraft`              | boolean.                                                                                                                                                                                                                                                                                                                                                    |
| `headSha`              | head commit SHA (git OID). Empty string if unobserved. A transition emits `head-changed`, independent of `updated`.                                                                                                                                                                                                                                         |
| `baseRef`              | base branch name. A transition emits `base-changed`.                                                                                                                                                                                                                                                                                                        |
| `mergeable`            | `mergeable` \| `conflicting` \| `unknown`.                                                                                                                                                                                                                                                                                                                  |
| `mergeStateStatus`     | `behind` \| `blocked` \| `clean` \| `dirty` \| `draft` \| `has_hooks` \| `unstable` \| `unknown`. A transition (e.g. `clean` → `behind` after the base branch advances) participates in the change comparison and the delta id and surfaces as an `updated` delta.                                                                                          |
| `reviewDecision`       | `approved` \| `changes_requested` \| `review_required` \| `none`.                                                                                                                                                                                                                                                                                           |
| `checks`               | array of `{name, kind, status, conclusion, detailsUrl, runId?, jobId?}`, sorted deterministically. `kind` is `"check"` (CheckRun) or `"status"` (legacy StatusContext). A transition emits `ci-changed`.                                                                                                                                                    |
| `reviews`              | array of `{id, author, state, submittedAt, commit}`, sorted deterministically. A transition emits `review-changed`.                                                                                                                                                                                                                                         |
| `threads`              | array of `{id, resolved, comments}` (one row per review thread with an id; rows without an id are dropped upstream). A resolution-count or same-count identity swap emits `unresolved-threads-added`/`unresolved-threads-resolved`; a total-count-only change emits `review-threads-changed`.                                                               |
| `conversationComments` | exact integer total top-level comment count. A transition emits `new-comments`/`comments-removed`.                                                                                                                                                                                                                                                          |
| `reviewComments`       | exact integer inline review-reply count (distinct from `conversationComments`). A decrease emits `review-comments-removed`; an increase contributes to `review-comments-added` (see the class table).                                                                                                                                                       |
| `recentComments`       | bounded array of `{id, author}` for the most recent conversation comments — the basis `--ignore-authors` uses to attribute a `new-comments` increment to specific logins.                                                                                                                                                                                   |
| `labels`               | string[], sorted label names. A transition emits `relabeled`.                                                                                                                                                                                                                                                                                               |
| `assignees`            | string[], sorted assignee logins. A transition emits `assignees-changed`.                                                                                                                                                                                                                                                                                   |
| `reviewRequests`       | string[], sorted requested-reviewer names (user/bot logins; teams as `org/slug`). A reviewer the token cannot resolve (e.g. a private team) is recorded as the literal placeholder `?` — deterministic per token, but two monitors with different token scopes can fingerprint the same PR differently there. A transition emits `review-requests-changed`. |

Issue fingerprint (built by `issueFingerprint`): `state` (`open` \| `closed`),
`updatedAt`, `labels` (string[], sorted), `assignees` (string[], sorted
logins), `conversationComments` (exact integer total), `recentComments`
(bounded `{id, author}` array, same shape as the PR field).
