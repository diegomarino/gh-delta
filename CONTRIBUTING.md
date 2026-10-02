# Contributing

Contributions land via pull request. The `main` branch is protected; direct
pushes are not accepted.

<!-- toc -->

**Contents**

- [Development Setup](#development-setup)
- [Scope and review checklist for docs/API edits](#scope-and-review-checklist-for-docsapi-edits)
- [Documentation structure](#documentation-structure)
- [Commit Convention](#commit-convention)
- [Branch Protection](#branch-protection)
- [Releases](#releases)
- [Entity Research](#entity-research)

<!-- /toc -->

## Development Setup

Use Node 22 or newer; Node 24 is recommended for development. CI runs tests
on Node 22 and runs the suite with coverage on Node 24. Lint, formatting,
skill discovery, generated skill verification, and package checks run once
on Node 24. Distribution checks also use Node 24.

```bash
npm install
```

Run the gate before every PR:

```bash
npm run check        # eslint + prettier check + node --test
npm run release:check # + coverage + npm pack --dry-run
npm test            # when docs or APIs changed, include this explicitly as a minimum
```

Zero runtime dependencies is a hard rule. Do not add a runtime dependency
unless it materially improves correctness.

## Scope and review checklist for docs/API edits

- If a CLI flag, schema, or delta class changes:
  - update the relevant page in the [`contract` index](docs/contract.md) **first** — these pages are the canonical source of truth; README and architecture link to it rather than restate its tables
  - then update [README.md](README.md) for any user-visible wording changes
  - then update [docs/architecture.md](docs/architecture.md) if internal behavior changed (link directly to the relevant contract page rather than duplicating contract tables)
- If public imports or programmatic behavior changes, update:
  - [package.json](package.json#exports) export surface
  - [docs/contract.md](docs/contract.md)
- If release logic changes, update:
  - [docs/release-checklist.md](docs/release-checklist.md)

## Documentation structure

Use [the documentation map](docs/README.md) to find the page for a task.
Keep contracts in `docs/contract/`, walkthroughs in `docs/guides/`, operator
procedures in `docs/operations/`, and internal design in `docs/architecture/`.
Keep runnable examples beside their files in `examples/`.

When splitting a page, move all rules, examples, caveats and historical notes.
Keep its old path and section anchors as an index and update inbound links to
the new destinations. Put prerequisites and warnings next to the steps they
qualify. The independently installed skill keeps its procedures under
`skills/gh-delta/references/` and links externally to repository material.

Aim for 30–80 lines per index and 100–250 per topic. Review pages over 300 lines
or 15 KB for a meaningful split; complete schemas and procedures may exceed
these guides. Preserve information rather than cutting it to meet a limit.
The generated changelog remains release-owned.

Add a contents list after the introduction when a page has at least six H2/H3
sections, or more than 150 lines and at least three such sections. Count
headings outside code fences and measure length before adding the contents
list. List H2 sections by default; include H3
only for independently useful lookups. Pages that already serve as indexes
need no extra contents list. Use `<!-- toc -->` and `<!-- /toc -->` around it.
Keep heading levels sequential and heading text unique (MD001 and MD024).
Generated flag pages include their contents list automatically.

Flag pages are generated per command from `lib/help.mjs`; run
`npm run build:skill` after metadata changes. `npm run skill:check` verifies
all generated pages, and `npm test` checks documentation links and the
published documentation inventory. Update the explicit `package.json` file
list when adding a published directory; local process artifacts stay excluded.

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
[`docs/release-checklist.md`](docs/release-checklist.md#release-process) for
the full release process. Never hand-edit `CHANGELOG.md` or the `version`
field in `package.json`; release-please owns both.

## Entity Research

Before proposing a new watch entity, read the promotion checklist in
[`docs/entities-research/README.md`](docs/entities-research/README.md).
