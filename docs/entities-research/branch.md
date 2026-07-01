# Branch Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

No first-class `gh branch list --json` repository command was observed. Branch
research currently points to `gh api` and repository metadata.

## Fetch Surface

Primary observed command:

```bash
gh repo view <owner/repo> --json defaultBranchRef
```

Fallback or API command(s):

```bash
gh api repos/{owner}/{repo}/branches
gh api repos/{owner}/{repo}/branches/<branch>
```

## Discoverable JSON Fields

Relevant `gh repo view --json` field:

```text
defaultBranchRef
```

Branch list fields are API payload fields rather than `gh --json`
field-discovered fields.

## Candidate Stable Identity

Primary key: branch `name` within one repository.

Secondary keys: current commit SHA, protection metadata.

## Candidate Delta Fingerprint

Likely useful fields:

- branch name
- head commit SHA
- protection status
- required status checks or ruleset links where available

Fields to avoid or normalize:

- Full protection/ruleset objects until permission and shape behavior are known.

## Pagination And Scope Notes

Branch lists can be paginated through the REST API. Protected branch and ruleset
metadata can be permission-sensitive.

## Risks And Unknowns

- Branch deletion and recreation semantics need a model.
- Force-push behavior overlaps with commit monitoring.
- Rulesets and branch protection may need separate API calls and permissions.

## Contract Recommendation

Do not expose branch as an entity yet. Keep `--branch` reserved for future
selectors where the entity being observed requires a branch or ref.
