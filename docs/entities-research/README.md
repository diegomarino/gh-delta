# GitHub Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

This directory records what `gh` can expose for repository-associated entities
that may become future `gh-delta` watch scopes. These notes do not define
supported CLI flags, snapshot schemas, report schemas, or outpost payloads.

The current public entity contract remains intentionally narrow:

```bash
--entities pr
--entities issue
--entities pr,issue
```

Do not add public selectors such as `--filter`, `--query`, `--label`,
`--branch`, `commit`, `release`, `workflow-run`, or `discussion` from these
research notes alone. Promote an entity only after its identity, pagination,
permissions, fingerprint, and truncation behavior have been verified.

## Refresh Policy

This subtree ships inside the npm tarball as reference material, not as a
runtime dependency. Its field lists reflect a point-in-time snapshot of the
GitHub CLI and GraphQL schema and will drift out of date. Before promoting an
entity out of this directory, or relying on one of these pages' field lists
for implementation work, re-run field discovery against the live GitHub
GraphQL schema and `gh <command> --json` output, then bump that page's "Last
verified" date.

## Verification Sources

- Context7 resolved the GitHub CLI manual as `/websites/cli_github_manual`.
- Local `gh <command> --help` output.
- Local `gh <command> --json` field discovery. In GitHub CLI 2.95.0, invoking
  commands with `--json` and no fields prints the accepted JSON fields before
  making an API request.

## Research Files

| File                                         | Purpose                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| [_template.md](_template.md)                 | Template for future entity research pages.                                          |
| [pr.md](pr.md)                               | Pull request list/view fields and current detector implications.                    |
| [issue.md](issue.md)                         | Issue list/view fields and hierarchy/state fields not yet fingerprinted.            |
| [workflow-run.md](workflow-run.md)           | GitHub Actions run fields and run-scoped filters.                                   |
| [check.md](check.md)                         | PR check/status surfaces and commit-check gaps.                                     |
| [release.md](release.md)                     | Release list/view fields.                                                           |
| [discussion.md](discussion.md)               | Discussion preview command fields and risks.                                        |
| [commit.md](commit.md)                       | Commit search and API-only repository commit enumeration.                           |
| [branch.md](branch.md)                       | Branch API surfaces and branch selector caveats.                                    |
| [repo-metadata.md](repo-metadata.md)         | Repository metadata surfaces that are useful context but risky as deltas.           |
| [api-only-surfaces.md](api-only-surfaces.md) | Surfaces that likely require `gh api` rather than first-class `gh --json`.          |
| [selectors.md](selectors.md)                 | Applicability matrix for future selectors such as branch, label, workflow, and tag. |

## Promotion Checklist

Before an entity becomes part of the public contract:

1. Identify a stable primary key.
2. Define broad fetch semantics that do not erase closed, merged, missing, or
   permission-hidden objects accidentally.
3. Prove pagination or truncation behavior and fail closed when a scope is too
   broad.
4. Define a normalized fingerprint that avoids noisy ordering changes.
5. Add fixture-backed tests for baseline, no-change, changed, missing, and
   still-missing behavior.
6. Document how the entity affects state-file derivation, report shape, and
   outpost event identity.
