# Commit Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Commits are likely future entities, but the high-level `gh` surface observed so
far is search-oriented rather than repository snapshot-oriented.

## Fetch Surface

Primary observed command:

```bash
gh search commits --json <fields> -- <query>
```

Fallback or API command(s):

```bash
gh api repos/{owner}/{repo}/commits
gh api repos/{owner}/{repo}/commits/<ref>
gh api repos/{owner}/{repo}/compare/<base>...<head>
```

## Discoverable JSON Fields

Fields accepted by `gh search commits --json`:

```text
author
commit
committer
id
parents
repository
sha
url
```

## Candidate Stable Identity

Primary key: `sha`.

Secondary keys: `repository`, `parents`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `sha`
- `parents`
- `commit.author`, `commit.committer`
- `commit.message`
- `repository`

Fields to avoid or normalize:

- Search result text matching and ranking.
- Any timestamp comparison that is not anchored to a branch or ref.

## Pagination And Scope Notes

`gh search commits` is query/index based. It should not be treated as an
authoritative branch or repository commit stream.

Repository commit polling likely needs `gh api` with explicit branch/ref,
pagination, and a retention strategy. A future commit entity should use
`--branch` as a real selector, not as a watcher identity.

## Risks And Unknowns

- Force-push and rewritten history semantics need a deliberate model.
- Branch selection, compare windows, and missing commits are harder than issue
  and PR snapshots.
- Commit enumeration is API-only in the observed CLI surface.

## Contract Recommendation

Do not expose `commit` yet. Reserve `--branch` for future commit-related
selectors, but keep the current public contract to PR and issue entities.
