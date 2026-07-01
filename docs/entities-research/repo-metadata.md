# Repository Metadata Research

Status: research only, not public contract
Last verified: 2026-07-01
GitHub CLI version: 2.95.0

Repository metadata is useful context for future detectors, but it is a very
large and noisy delta stream if treated as a first-class entity.

## Fetch Surface

Primary command(s):

```bash
gh repo view <owner/repo> --json <fields>
gh repo list <owner-or-org> --json <fields>
```

## Discoverable JSON Fields

Fields accepted by `gh repo view --json` and `gh repo list --json`:

```text
archivedAt
assignableUsers
codeOfConduct
contactLinks
createdAt
defaultBranchRef
deleteBranchOnMerge
description
diskUsage
forkCount
fundingLinks
hasDiscussionsEnabled
hasIssuesEnabled
hasProjectsEnabled
hasWikiEnabled
homepageUrl
id
isArchived
isBlankIssuesEnabled
isEmpty
isFork
isInOrganization
isMirror
isPrivate
isSecurityPolicyEnabled
isTemplate
isUserConfigurationRepository
issueTemplates
issues
labels
languages
latestRelease
licenseInfo
mentionableUsers
mergeCommitAllowed
milestones
mirrorUrl
name
nameWithOwner
openGraphImageUrl
owner
parent
primaryLanguage
projects
projectsV2
pullRequestTemplates
pullRequests
pushedAt
rebaseMergeAllowed
repositoryTopics
securityPolicyUrl
squashMergeAllowed
sshUrl
stargazerCount
templateRepository
updatedAt
url
usesCustomOpenGraphImage
viewerCanAdminister
viewerDefaultCommitEmail
viewerDefaultMergeMethod
viewerHasStarred
viewerPermission
viewerPossibleCommitEmails
viewerSubscription
visibility
watchers
```

## Candidate Stable Identity

Primary key: `nameWithOwner`.

Secondary keys: `id`, `url`.

## Candidate Delta Fingerprint

Likely useful fields:

- `defaultBranchRef`
- feature flags such as `hasIssuesEnabled`, `hasDiscussionsEnabled`,
  `hasProjectsEnabled`
- merge settings such as `deleteBranchOnMerge`, `squashMergeAllowed`,
  `rebaseMergeAllowed`, `mergeCommitAllowed`
- `visibility`, `isArchived`, `isPrivate`
- `latestRelease`
- `repositoryTopics`, `labels`, `milestones`

Fields to avoid or normalize:

- Viewer-specific fields.
- Counts such as stars/watchers unless the product explicitly watches popularity.
- Nested project/template fields until their own contracts are researched.

## Pagination And Scope Notes

Repository metadata is one object, but many fields contain nested collections
that may be paginated or permission-dependent.

## Risks And Unknowns

- Huge surface area.
- Many fields are context, not actionable deltas.
- Viewer fields can differ by token and operator.

## Contract Recommendation

Use repository metadata as context or preflight input, not as a first-class delta
entity until there is a concrete action loop.
