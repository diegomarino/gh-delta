# Check And Status Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Checks are currently observed indirectly through PR `statusCheckRollup`. GitHub
CLI also exposes a PR-focused checks command.

## Fetch Surface

Primary command(s):

```bash
gh pr checks <number-or-url-or-branch> -R <owner/repo> --json <fields>
```

Related fields:

```bash
gh pr list -R <owner/repo> --json statusCheckRollup
gh pr view <number> -R <owner/repo> --json statusCheckRollup
```

Fallback or API command(s):

```bash
gh api repos/{owner}/{repo}/commits/<ref>/check-runs
gh api repos/{owner}/{repo}/commits/<ref>/status
```

## Discoverable JSON Fields

Fields accepted by `gh pr checks --json`:

```text
bucket
completedAt
description
event
link
name
startedAt
state
workflow
```

`gh pr checks` also uses exit code `8` when checks are pending.

## Candidate Stable Identity

Primary key: likely `name` plus `workflow` within a PR head SHA.

Secondary keys: `link`, `event`.

## Candidate Delta Fingerprint

Likely useful fields:

- `bucket`
- `state`
- `startedAt`, `completedAt`
- `workflow`
- `description`
- `link`

Fields to avoid or normalize:

- Timing fields if they cause noisy deltas after final state is known.
- Descriptions if provider wording changes without status meaning changing.

## Pagination And Scope Notes

The first-class command is PR-oriented. Branch-level or commit-level checks
likely need `gh api` and a separate identity model based on commit SHA.

## Risks And Unknowns

- `gh pr checks` selects one PR, so broad repository polling would need one
  command per PR or a different API.
- CI providers can rename checks or emit duplicate names.
- Commit status and check run APIs have separate models.

## Contract Recommendation

Keep checks inside the PR fingerprint for now. Do not expose `check` as a
standalone entity until commit-level API behavior is researched.
