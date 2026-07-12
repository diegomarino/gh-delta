# Changelog

All notable changes to this package will be documented here.

This project follows semantic versioning.

## [0.3.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.2.0...gh-delta-v0.3.0) (2026-07-10)


### Features

* add optional --summaries semantic layer for PR deltas ([#14](https://github.com/diegomarino/gh-delta/issues/14)) ([c1e7aa1](https://github.com/diegomarino/gh-delta/commit/c1e7aa156da5a6e3c19439b37d29efb05a60bb2b))
* **cli:** gh-delta list — read-only inventory of every local monitor ([#11](https://github.com/diegomarino/gh-delta/issues/11)) ([0f757da](https://github.com/diegomarino/gh-delta/commit/0f757da68599ba6f2b5571e0cca35b36eec40cb8))
* name the exact checks and reviews behind ci-changed/review-changed details ([#12](https://github.com/diegomarino/gh-delta/issues/12)) ([d948d3e](https://github.com/diegomarino/gh-delta/commit/d948d3e6718b0252feb1b6ea427eb48fe2a88d12))

## [0.2.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.1.1...gh-delta-v0.2.0) (2026-07-08)


### Features

* add content-addressed id to every delta ([#5](https://github.com/diegomarino/gh-delta/issues/5)) ([917ba42](https://github.com/diegomarino/gh-delta/commit/917ba42e68ceb787e4cfd12487ea3e4dd167518b))
* carry PR head branch (headRefName) on deltas ([#7](https://github.com/diegomarino/gh-delta/issues/7)) ([1e5e536](https://github.com/diegomarino/gh-delta/commit/1e5e536831b9cdfc877e352cd0eb3f0e688dbb3a))

## [0.1.1](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.1.0...gh-delta-v0.1.1) (2026-07-08)


### Bug Fixes

* add operator suggestions for draft-ready and reopened deltas ([#1](https://github.com/diegomarino/gh-delta/issues/1)) ([8ae8f5d](https://github.com/diegomarino/gh-delta/commit/8ae8f5dcef6489691259aeaf2bfaa4b9b1ff9398))

## 0.1.0 - 2026-07-08

- Initial `gh-delta` detector CLI.
- Classified first-observed closed/merged items as `first-seen` so a cold start
  against a repo with history does not report them as newly created.
- Validated snapshot `meta.horizon` and legacy `updatedAt` as ISO dates, failing
  with exit 2 before fetching instead of computing a bogus incremental window.
- Added one-shot JSON and text output through the single `gh-delta` CLI.
- Added stable `--monitor-id` identity and monitor-scoped derived snapshot paths.
- Added deterministic PR and issue delta classification.
- Added GraphQL review-thread enrichment for open PR unresolved-thread signals.
- Added optional at-most-once outpost delivery.
- Added research-only docs for future entity and selector design.
- Added Node test suite, linting, formatting, coverage reporting, and package
  dry-run checks.
- Added `schemaVersion: 1` to every JSON report (success and error) so consumers
  can pin the report shape at runtime.
- Made the outpost `eventId` order-independent by sorting `classes` before
  joining.
- Hardened `docs/contract.md`: class applicability table, closed-set /
  non-empty / forward-compat guarantees, `from`/`to` opacity policy and
  nullability, error-report shape, and snapshot semantics.
- Hardened snapshot validation so malformed state files fail before GitHub fetches.
- Changed derived snapshot filenames to collision-free encoded identity segments.
- Added `reappeared` delta classification for objects returning after missing fetches.
- Closed the accidental package root import surface; documented subpaths remain public.
- Clarified outpost as best-effort delivery and separated semantic `eventId` from delivery attempts.
- Fixed CLI help drift, duplicate `--format` handling, package README image contents, and live e2e documentation.
