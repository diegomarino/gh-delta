# API-Only And Mixed Surface Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Some repository-associated surfaces do not have a stable first-class
`gh <command> --json` list/view command in the observed CLI version. They may
still be available through `gh api`, but API-backed entities need extra design
work before becoming public.

## Observed Mixed Surfaces

| Surface                    | Observed command                                                           | JSON support | Notes                                                                |
| -------------------------- | -------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| Branches                   | `gh api repos/{owner}/{repo}/branches`                                     | API only     | No first-class branch list JSON command observed.                    |
| Commit enumeration         | `gh api repos/{owner}/{repo}/commits`                                      | API only     | `gh search commits --json` exists but is search/index based.         |
| Commit statuses/check runs | `gh api repos/{owner}/{repo}/commits/<ref>/status` and `/check-runs`       | API only     | `gh pr checks --json` is PR-oriented.                                |
| Milestones                 | `gh api repos/{owner}/{repo}/milestones`                                   | API only     | Milestone objects also appear nested under PR/issue fields.          |
| Rulesets                   | `gh ruleset list`; `gh api repos/{owner}/{repo}/rulesets`                  | Mixed        | `gh ruleset list` did not expose `--json` in local `gh` 2.95.0.      |
| Variables/secrets/cache    | `gh variable list --json`, `gh secret list --json`, `gh cache list --json` | Mixed        | Permission-sensitive operational metadata, not core activity deltas. |

## `gh api` Notes

`gh api` supports:

- REST paths such as `repos/{owner}/{repo}/issues`.
- GraphQL through `gh api graphql`.
- `--paginate` and `--slurp` for pagination.
- `--jq` and `--template` for response shaping.
- placeholder expansion for `{owner}`, `{repo}`, and `{branch}`.

These capabilities are useful, but they put more schema and pagination burden on
`gh-delta` than first-class `gh --json` commands.

## Contract Recommendation

Do not expose API-only entities until each one has:

1. a documented endpoint and permission model;
2. pagination fixtures;
3. stable identity and fingerprint rules;
4. fail-closed truncation behavior;
5. clear state-file derivation and outpost identity rules.
