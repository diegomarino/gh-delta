# Contributing

Contributions land via pull request. The `main` branch is protected; direct
pushes are not accepted.

## Development Setup

```bash
npm install
```

Run the gate before every PR:

```bash
npm run check        # eslint + prettier check + node --test
npm run release:check # + coverage + npm pack --dry-run
```

Zero runtime dependencies is a hard rule. Do not add a runtime dependency
unless it materially improves correctness.

## Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/) are required.
Releases and the changelog are generated from commit messages by
[release-please](https://github.com/googleapis/release-please); a
non-conforming message is invisible to the release pipeline.

| Type                                         | Release effect                 | Changelog section    |
| -------------------------------------------- | ------------------------------ | -------------------- |
| `feat:`                                      | minor bump                     | Features             |
| `fix:`                                       | patch bump                     | Bug Fixes            |
| `perf:`, `refactor:`, `docs:`                | patch bump                     | own section per type |
| `chore:`, `test:`, `ci:`, `style:`, `build:` | no release                     | hidden               |
| `feat!:` / `BREAKING CHANGE:` footer         | major bump (minor while `0.x`) | Breaking Changes     |

The scope is optional: `feat(cli): add --format flag`.

## Branch Protection

`main` requires a passing PR. Do not push directly to `main`.

## Releases

Releases are automated via release-please; see
[`docs/go-public-runbook.md`](docs/go-public-runbook.md) for the full
release process. Never hand-edit `CHANGELOG.md` or the `version` field in
`package.json`; release-please owns both.

## Entity Research

Before proposing a new watch entity, read the promotion checklist in
[`docs/entities-research/README.md`](docs/entities-research/README.md).
