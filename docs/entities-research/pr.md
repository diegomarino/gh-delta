# Pull Request Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Pull requests are already part of the public `--entities` contract. This page
tracks the broader data surface so future scope and filter decisions do not
accidentally weaken the current missing-object and closed-state guarantees.

## Current Implementation Fetch Surface

The detector's current implementation fetches PRs through `gh api graphql`, not
through `gh pr list`. Keep this aligned with
[`docs/architecture.md`](../architecture.md#github-fetch-strategy).

Current behavior:

- open-items phase: GraphQL `UPDATED_AT` pagination for open PRs;
- updated-items phase: GraphQL `UPDATED_AT` pagination across all PR states until
  the prior snapshot horizon;
- fail closed on page-cap overflow or nested connection overflow;
- count review-thread state through GraphQL `reviewThreads`.

## Historical GitHub CLI Field Discovery

These commands were used to discover GitHub CLI JSON fields. They are research
inputs, not the current detector fetch path.

```bash
gh pr list -R <owner/repo> --state all --limit 500 --json <fields>
gh pr view <number-or-url-or-branch> -R <owner/repo> --json <fields>
```

Related command(s):

```bash
gh pr checks <number-or-url-or-branch> -R <owner/repo> --json <fields>
gh search prs --json <fields> -- <query>
```

## Discoverable JSON Fields

Fields accepted by `gh pr list --json` and `gh pr view --json` during field
discovery:

```text
additions
assignees
author
autoMergeRequest
baseRefName
baseRefOid
body
changedFiles
closed
closedAt
closingIssuesReferences
comments
commits
createdAt
deletions
files
fullDatabaseId
headRefName
headRefOid
headRepository
headRepositoryOwner
id
isCrossRepository
isDraft
labels
latestReviews
maintainerCanModify
mergeCommit
mergeStateStatus
mergeable
mergedAt
mergedBy
milestone
number
potentialMergeCommit
projectCards
projectItems
reactionGroups
reviewDecision
reviewRequests
reviews
state
statusCheckRollup
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
isDraft
statusCheckRollup
reviewDecision
latestReviews
mergeable
comments
headRefOid
```

## Candidate Stable Identity

Primary key: `number` within one repository.

Secondary keys: `id`, `fullDatabaseId`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `state`, `closed`, `closedAt`, `mergedAt`, `mergedBy`
- `isDraft`
- `headRefOid`, `headRefName`, `baseRefName`, `baseRefOid`
- `statusCheckRollup`
- `reviewDecision`, `latestReviews`, `reviews`, `reviewRequests`
- `reviewThreads`, especially `isResolved`
- `mergeable`, `mergeStateStatus`
- `comments`, `reactionGroups`
- `labels`, `milestone`, `assignees`
- `files`, `changedFiles`, `additions`, `deletions`

Fields to avoid or normalize:

- Arrays whose order may be API-dependent.
- Bodies and comments unless there is a clear need to detect content changes.
- `files` and `commits` for broad polling unless pagination and volume are
  validated.

## Pagination And Scope Notes

Current behavior is GraphQL-only. It fails closed when page caps or nested
connections would make the snapshot incomplete. This is a correctness rule:
filtering too early can make merged or closed PRs disappear and look like scope
loss.

Older research used `gh pr list --state all --limit 500`; keep that command in
the historical field-discovery section only, not as current behavior.

`gh search prs` is useful for research, but it is not an authoritative snapshot
source for this detector until indexing, query, and missing-object semantics are
proven.

## Risks And Unknowns

- Label, file, review request, and full review data may add useful signal but can
  also increase noise.
- `statusCheckRollup` shape needs periodic validation against real GitHub output.
- Future filters must not hide closed or merged PRs that are already in the
  snapshot.

## Contract Recommendation

Keep public support at `--entities pr`. Do not add PR filters until a concrete
use case proves how filtered scope should behave for previously known objects
that leave the filter.
