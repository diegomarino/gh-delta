# Changelog

All notable changes to this package will be documented here.

This project follows semantic versioning once published to npm.

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
