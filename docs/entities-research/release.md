# Release Entity Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Releases may become useful for repositories where published artifacts are the
operational signal, but they are not part of the current detector contract.

## Fetch Surface

Primary command(s):

```bash
gh release list -R <owner/repo> --json <fields>
gh release view <tag> -R <owner/repo> --json <fields>
```

Fallback or API command(s):

```bash
gh api repos/{owner}/{repo}/releases
```

## Discoverable JSON Fields

Fields accepted by `gh release list --json`:

```text
createdAt
isDraft
isImmutable
isLatest
isPrerelease
name
publishedAt
tagName
```

Fields accepted by `gh release view --json`:

```text
apiUrl
assets
author
body
createdAt
databaseId
id
isDraft
isImmutable
isPrerelease
name
publishedAt
tagName
tarballUrl
targetCommitish
uploadUrl
url
zipballUrl
```

## Candidate Stable Identity

Primary key: `tagName`.

Secondary keys: `databaseId`, `id`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `tagName`
- `name`
- `isDraft`, `isPrerelease`, `isLatest`, `isImmutable`
- `publishedAt`, `createdAt`
- `targetCommitish`
- `assets`

Fields to avoid or normalize:

- `body` unless release-note content changes matter.
- Download URLs unless they are stable enough to avoid noisy diffs.
- Asset arrays until ordering and asset identity are validated.

## Pagination And Scope Notes

List and view expose different field sets. A broad detector may need list for
baseline plus targeted view calls for changed releases.

## Risks And Unknowns

- Draft visibility depends on permissions.
- Assets can be noisy if upload metadata changes.
- `isLatest` can change when another release is published, causing valid but
  broad deltas.

## Contract Recommendation

Do not expose releases until there is a concrete action loop for release events.
