# Workflow Run Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Workflow runs are a likely future entity because they represent CI state at the
repository level, not only through pull requests.

## Fetch Surface

Primary command(s):

```bash
gh run list -R <owner/repo> --json <fields>
gh run view <run-id> -R <owner/repo> --json <fields>
```

Useful `gh run list` filters:

```text
--branch <branch>
--commit <sha>
--created <date>
--event <event>
--limit <n>
--status <status>
--user <user>
--workflow <workflow>
```

## Discoverable JSON Fields

Fields accepted by `gh run list --json`:

```text
attempt
conclusion
createdAt
databaseId
displayTitle
event
headBranch
headSha
name
number
startedAt
status
updatedAt
url
workflowDatabaseId
workflowName
```

Fields accepted by `gh run view --json`:

```text
attempt
conclusion
createdAt
databaseId
displayTitle
event
headBranch
headSha
jobs
name
number
startedAt
status
updatedAt
url
workflowDatabaseId
workflowName
```

## Candidate Stable Identity

Primary key: `databaseId`.

Secondary keys: `workflowDatabaseId`, `number`, `headSha`, `attempt`.

## Candidate Delta Fingerprint

Likely useful fields:

- `status`, `conclusion`, `attempt`
- `headBranch`, `headSha`
- `workflowName`, `workflowDatabaseId`
- `event`
- `createdAt`, `startedAt`, `updatedAt`
- `jobs` from `gh run view`

Fields to avoid or normalize:

- Job arrays until ordering and pagination are fixture-backed.
- Display names as primary identity because users can rename workflows.

## Pagination And Scope Notes

Workflow runs are high-volume and retention-limited. Any future implementation
must choose a bounded fetch window and define what it means when older runs age
out of the API.

`gh run list` already has first-class selectors for branch, commit, workflow,
event, status, and actor. These should be researched as workflow-run selectors,
not generic global `gh-delta` filters.

## Risks And Unknowns

- High churn can make broad snapshots noisy.
- Retention can make old runs disappear for reasons unrelated to repository
  activity.
- Organization and enterprise ruleset workflows may omit workflow names due to
  GitHub API limitations.

## Contract Recommendation

Do not expose `workflow-run` as an entity until fetch windows, retention
behavior, and state advancement semantics are defined.
