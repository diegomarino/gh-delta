# Issue Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Issues are already part of the public `--entities` contract. GitHub CLI exposes
more issue fields than the current detector fingerprints, especially around
issue hierarchy, blocking, and issue type.

## Current Implementation Fetch Surface

The detector's current implementation fetches issues through `gh api graphql`,
not through `gh issue list`. Keep this aligned with
[`docs/architecture.md`](../architecture.md#github-fetch-contract).

Current behavior:

- open-items phase: GraphQL `UPDATED_AT` pagination for open issues;
- updated-items phase: GraphQL `UPDATED_AT` pagination across all issue states
  until the prior snapshot horizon;
- fail closed on page-cap overflow or nested connection overflow.

## Historical GitHub CLI Field Discovery

These commands were used to discover GitHub CLI JSON fields. They are research
inputs, not the current detector fetch path.

```bash
gh issue list -R <owner/repo> --state all --limit 500 --json <fields>
gh issue view <number-or-url> -R <owner/repo> --json <fields>
```

Related command(s):

```bash
gh search issues --json <fields> -- <query>
```

## Discoverable JSON Fields

Fields accepted by `gh issue list --json` and `gh issue view --json` during
field discovery:

```text
assignees
author
blockedBy
blocking
body
closed
closedAt
closedByPullRequestsReferences
comments
createdAt
id
isPinned
issueType
labels
milestone
number
parent
projectCards
projectItems
reactionGroups
state
stateReason
subIssues
subIssuesSummary
title
updatedAt
url
```

Current detector fields:

```text
number
title
state
updatedAt
labels
comments
```

## Candidate Stable Identity

Primary key: `number` within one repository.

Secondary keys: `id`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `state`, `stateReason`, `closed`, `closedAt`
- `updatedAt`
- `labels`, `milestone`, `issueType`
- `assignees`, `author`
- `comments`, `reactionGroups`
- `parent`, `subIssues`, `subIssuesSummary`
- `blockedBy`, `blocking`
- `closedByPullRequestsReferences`

Fields to avoid or normalize:

- `body` and full comment content unless content-level deltas are required.
- Project fields until project APIs and permissions are researched separately.
- Hierarchy arrays until live shapes are fixture-backed.

## Pagination And Scope Notes

Current behavior is GraphQL-only. It fails closed when page caps would make the
snapshot incomplete. This keeps closed issues observable and avoids silently
erasing snapshot memory.

Older research used `gh issue list --state all --limit 500`; keep that command
in the historical field-discovery section only, not as current behavior.

`gh search issues` can express useful future filters, but search results are not
equivalent to an authoritative repository issue snapshot.

## Risks And Unknowns

- Newer fields such as `issueType`, `parent`, `subIssues`, `blockedBy`, and
  `blocking` need live shape validation before fingerprinting.
- A label filter can create false `missing` deltas unless scope-exit semantics
  are designed deliberately.
- Project fields may be permission-sensitive and noisy.

## Contract Recommendation

Keep public support at `--entities issue`. Do not add issue filters until the
detector has an explicit policy for objects that were known before but no longer
match the filter.
