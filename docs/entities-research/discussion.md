# Discussion Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

GitHub CLI marks discussion support as preview and subject to change without
notice. Treat this surface as experimental.

## Fetch Surface

Primary command(s):

```bash
gh discussion list -R <owner/repo> --json <fields>
gh discussion view <number-or-url> -R <owner/repo> --json <fields>
```

## Discoverable JSON Fields

Fields accepted by `gh discussion list --json`:

```text
answerChosenAt
answerChosenBy
answered
author
body
category
closed
closedAt
createdAt
id
labels
locked
number
stateReason
title
updatedAt
url
```

Fields accepted by `gh discussion view --json`:

```text
answerChosenAt
answerChosenBy
answered
author
body
category
closed
closedAt
comments
createdAt
id
labels
locked
number
reactionGroups
state
stateReason
title
updatedAt
url
```

## Candidate Stable Identity

Primary key: `number` within one repository.

Secondary keys: `id`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `closed`, `closedAt`, `state`, `stateReason`
- `answered`, `answerChosenAt`, `answerChosenBy`
- `category`
- `labels`
- `locked`
- `updatedAt`
- `comments`, `reactionGroups`

Fields to avoid or normalize:

- `body` unless content-level deltas are required.
- Nested comments until shape and pagination are validated.

## Pagination And Scope Notes

Discussions may be disabled per repository. Preview status means field and
command behavior can change faster than stable surfaces.

## Risks And Unknowns

- Preview command.
- Comment nesting and count semantics need live validation.
- Repositories without discussions should fail with a clear non-destructive
  error if this entity is ever supported.

## Contract Recommendation

Do not expose discussions until GitHub CLI support is stable enough for a
published contract.
