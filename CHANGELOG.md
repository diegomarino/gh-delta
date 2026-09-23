# Changelog

All notable changes to this package will be documented here.

This project follows semantic versioning.

## [0.6.1](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.6.0...gh-delta-v0.6.1) (2026-09-23)


### Documentation

* **examples:** point --state-dir at XDG state, not the caller's cwd ([#55](https://github.com/diegomarino/gh-delta/issues/55)) ([a89f2ef](https://github.com/diegomarino/gh-delta/commit/a89f2efc5bd1609c9d78998f61dc8e5ba398f4a6))

## [0.6.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.5.0...gh-delta-v0.6.0) (2026-09-21)


### Features

* add actionable details and ignored comment authors ([#37](https://github.com/diegomarino/gh-delta/issues/37)) ([79960d0](https://github.com/diegomarino/gh-delta/commit/79960d0d23f951f45a89cc3e2bd731af16e403ec))
* add agent-oriented output formats ([#44](https://github.com/diegomarino/gh-delta/issues/44)) ([eeffae3](https://github.com/diegomarino/gh-delta/commit/eeffae397f95a2c19c6391ff3528fbebcf741d28))
* add bounded wait command ([#45](https://github.com/diegomarino/gh-delta/issues/45)) ([c293a0e](https://github.com/diegomarino/gh-delta/commit/c293a0ea44c20802d009c49eb5f2651008352045))
* add durable delta log replay ([#34](https://github.com/diegomarino/gh-delta/issues/34)) ([d3fbf31](https://github.com/diegomarino/gh-delta/commit/d3fbf311a81c9a0a04c4124dc8ae6cd51614ec14))
* add economical watch directory fetching ([#40](https://github.com/diegomarino/gh-delta/issues/40)) ([38c1f7d](https://github.com/diegomarino/gh-delta/commit/38c1f7d700c7ffa21bb8818ca08d45281014ebfc))
* add local watch directory selection ([#39](https://github.com/diegomarino/gh-delta/issues/39)) ([38ab15a](https://github.com/diegomarino/gh-delta/commit/38ab15a9915e40838b363ea62e7c71538253a032))
* add opt-in GraphQL rate limit floor ([#42](https://github.com/diegomarino/gh-delta/issues/42)) ([be672d1](https://github.com/diegomarino/gh-delta/commit/be672d1c035369813135dc5af2076d77d713ca0a))
* add post-detection attention filters ([#33](https://github.com/diegomarino/gh-delta/issues/33)) ([0fcb81a](https://github.com/diegomarino/gh-delta/commit/0fcb81ada803626c5ddb5ac4c909a56a0859379c))
* add setup and diagnostics commands ([86fd2b8](https://github.com/diegomarino/gh-delta/commit/86fd2b8220792f60a347cd08c68b42e16baf5d39))
* add setup and diagnostics commands ([a292409](https://github.com/diegomarino/gh-delta/commit/a29240992ad9979ebe187ae5c3950f761ca34038))
* add status and stale detection ([#46](https://github.com/diegomarino/gh-delta/issues/46)) ([a824559](https://github.com/diegomarino/gh-delta/commit/a82455992f655582c49fd095aa26c1f3cb39f887))
* aggregate detector passes across repositories ([#43](https://github.com/diegomarino/gh-delta/issues/43)) ([4ee57dc](https://github.com/diegomarino/gh-delta/commit/4ee57dc0d4d1926fefea69a20eb9152aa4449b2a))
* compact retained delta logs ([#35](https://github.com/diegomarino/gh-delta/issues/35)) ([5189104](https://github.com/diegomarino/gh-delta/commit/5189104334359f740c4361f034a56d95fc6ea507))
* detect head changes and review-thread identity ([#32](https://github.com/diegomarino/gh-delta/issues/32)) ([c35aaeb](https://github.com/diegomarino/gh-delta/commit/c35aaebb3ef1d56543dc753d938424b5041a58af))
* distribute gh-delta for agents ([#47](https://github.com/diegomarino/gh-delta/issues/47)) ([bd69a0e](https://github.com/diegomarino/gh-delta/commit/bd69a0e4f28eca62b54a3ab484506c982ece370b))
* enrich emitted deltas on demand ([#41](https://github.com/diegomarino/gh-delta/issues/41)) ([99eb38a](https://github.com/diegomarino/gh-delta/commit/99eb38adbee44dd30db70bb677bf7fa723cfa021))
* guard the snapshot with a deadline-based file lock ([#31](https://github.com/diegomarino/gh-delta/issues/31)) ([69328ca](https://github.com/diegomarino/gh-delta/commit/69328caaa700421c05b47c114ab1e24aa08ca5e0))
* scope monitor identity by worktree ([#36](https://github.com/diegomarino/gh-delta/issues/36)) ([c423feb](https://github.com/diegomarino/gh-delta/commit/c423feb6ed71138a1435158634ebaeed28dfc4c9))
* sign outpost deliveries with HMAC ([#38](https://github.com/diegomarino/gh-delta/issues/38)) ([2513dfd](https://github.com/diegomarino/gh-delta/commit/2513dfd3b9ca050baad3491a9a51c832a8d2353e))
* wave 0 foundations — shared duration parser and the two regression nets ([#28](https://github.com/diegomarino/gh-delta/issues/28)) ([1554ca2](https://github.com/diegomarino/gh-delta/commit/1554ca2b749c05e74fdaaafda46f47e1b09366cb))


### Bug Fixes

* **ci:** verify extension release URL ([9de0a22](https://github.com/diegomarino/gh-delta/commit/9de0a2218365d0b26cc89f1e5138d0cff584b5b7))
* dedupe outpost deliveries by delta id, not event id ([#29](https://github.com/diegomarino/gh-delta/issues/29)) ([dd39da4](https://github.com/diegomarino/gh-delta/commit/dd39da41820f0f26a30592ce52d2d7be05ef3495))
* **docs:** align schema preview command ([31e882d](https://github.com/diegomarino/gh-delta/commit/31e882db9bd6c9fd69d1261130a77b4a37d0ec76))
* **dx:** harden doctor and init safeguards ([bfe8d78](https://github.com/diegomarino/gh-delta/commit/bfe8d78354be01e6f09900154de8429a1fd219c4))
* **examples:** harden agent integration recipes ([18ee2c9](https://github.com/diegomarino/gh-delta/commit/18ee2c99f0055b8f3a4183c576e330062f6633c6))


### Documentation

* add agent-first examples and recipes ([228c113](https://github.com/diegomarino/gh-delta/commit/228c113fcc1051dfc6da1f1f6c4eb968e3a6178a))
* add agent-first examples and recipes ([53b4396](https://github.com/diegomarino/gh-delta/commit/53b4396c35254375cf31a12ac85e8ff8d702d737))
* add common PR loop demo ([#51](https://github.com/diegomarino/gh-delta/issues/51)) ([7e9fcf8](https://github.com/diegomarino/gh-delta/commit/7e9fcf8eea76f0489293a89409ef14290a73bdc9))
* keep scenario lifecycle with its launcher ([#53](https://github.com/diegomarino/gh-delta/issues/53)) ([bb90356](https://github.com/diegomarino/gh-delta/commit/bb903568e89ca7e4f4221cb5d1581b403765456a))
* restore generated output visuals ([1cd6649](https://github.com/diegomarino/gh-delta/commit/1cd6649b2d07e6c62518a161b2855e398bb2de21))
* restore generated output visuals ([ab14a63](https://github.com/diegomarino/gh-delta/commit/ab14a63cbb1b871f3159ba40e22ba7c5e6e4f3de))
* scope agent scenarios by session id ([#54](https://github.com/diegomarino/gh-delta/issues/54)) ([3df6c57](https://github.com/diegomarino/gh-delta/commit/3df6c574baa8677279a3ebcbf52c0191807c68bb))
* turn gh-delta skill into an operating guide ([#52](https://github.com/diegomarino/gh-delta/issues/52)) ([fd13968](https://github.com/diegomarino/gh-delta/commit/fd1396823acfdce9f10c32c2c32a89ce8b86d660))

## [0.5.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.4.0...gh-delta-v0.5.0) (2026-08-05)


### Features

* add seven neutral delta classes for agent feedback signals ([49eba4f](https://github.com/diegomarino/gh-delta/commit/49eba4f239d5d8e3e3cd7f25a3f0be8c84d84362))
* explain the new classes in details, text output, and help ([e3fe9be](https://github.com/diegomarino/gh-delta/commit/e3fe9be58b661a1d9e0bf5fc7ccc2504dc27de06))
* extend neutral GitHub signals from the [#23](https://github.com/diegomarino/gh-delta/issues/23) audit ([a679688](https://github.com/diegomarino/gh-delta/commit/a679688660b0f33f548a4d4e4d4d163d9825ed43))
* fetch base ref, labels, assignees, and review requests ([730ce69](https://github.com/diegomarino/gh-delta/commit/730ce69738da3beab8b9a1610745fc93162fd1c7))


### Bug Fixes

* suppress additive-field detail rows on upgrade ticks ([518331f](https://github.com/diegomarino/gh-delta/commit/518331f1a24dad84f8c8ab8c68fffd7bd47a932b))


### Documentation

* catch operator docs up with the new classes and audit notes ([0fc4c0c](https://github.com/diegomarino/gh-delta/commit/0fc4c0c41d6c284ff2570a4c34d8d49ad0a179fb))
* document the new classes and compared fingerprint fields ([8af1b84](https://github.com/diegomarino/gh-delta/commit/8af1b840fa03388dcdf292537945747c8418056e))
* rate-limit budget, unresolvable-reviewer placeholder, GHES opt-in stance ([3b4e029](https://github.com/diegomarino/gh-delta/commit/3b4e02972e6b47ebccee6b81766f7bc6023a31e4))
* showcase review-requests-changed in the example artifacts ([f5bb320](https://github.com/diegomarino/gh-delta/commit/f5bb320eddb7a3ec397dbd262ed55bd62f718fec))

## [0.4.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.3.1...gh-delta-v0.4.0) (2026-07-28)


### Features

* add --baseline-emit-state flag for pre-existing open items ([b903d4b](https://github.com/diegomarino/gh-delta/commit/b903d4ba5f42bd8bb345e62bd9fb1135e640588a))
* add mergeStateStatus enum to the delta summary ([1cfecdb](https://github.com/diegomarino/gh-delta/commit/1cfecdb9095fe5e09003256528d04af2417d6d9d))
* add opt-in baseline-state delta class to the detector ([6288815](https://github.com/diegomarino/gh-delta/commit/6288815cab81293e81378f7156707f632c07aa26))
* derive --repo from the git remote when omitted ([#18](https://github.com/diegomarino/gh-delta/issues/18)) ([c992b9e](https://github.com/diegomarino/gh-delta/commit/c992b9e14a2b2530da0e545e89261e6a79886e0b))
* mergeStateStatus in delta summary + opt-in baseline-state emission ([7502787](https://github.com/diegomarino/gh-delta/commit/75027874edf468a3dade0064aa30d7fbc9466b1a))
* observe mergeStateStatus in the PR fingerprint boundary ([6fb3bbe](https://github.com/diegomarino/gh-delta/commit/6fb3bbebb5ef52a87364e74c2863aacf655b95ef))


### Bug Fixes

* compare mergeStateStatus so merge-state transitions are not swallowed ([bf0d36b](https://github.com/diegomarino/gh-delta/commit/bf0d36b85e102fd948d603fe1f23b6e21d71f186))

## [0.3.1](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.3.0...gh-delta-v0.3.1) (2026-07-12)


### Bug Fixes

* pass gh GraphQL variables as raw string fields ([2a0be9b](https://github.com/diegomarino/gh-delta/commit/2a0be9b9a96c8a3de20f83e081448576c9a2e1a8))
* terminal-safe text output and clearer gh-delta list behavior ([056aebd](https://github.com/diegomarino/gh-delta/commit/056aebd6d5ea8db5ba573bc186523e5001d83108))


### Documentation

* complete delta-class coverage and scheduler provenance ([3ee690f](https://github.com/diegomarino/gh-delta/commit/3ee690fd3e793f978bc476a330b5086b26189485))
* correct contract and architecture reference gaps ([066f80c](https://github.com/diegomarino/gh-delta/commit/066f80cf4e13b02e0cec041c04d2455c9e95b7fb))
* document the release process and fix the package inventory ([25ff347](https://github.com/diegomarino/gh-delta/commit/25ff34748eec9709aaa8a01762c2ffa67088ce9a))
* fix research anchors, add refresh policy and a docs index ([ca4f673](https://github.com/diegomarino/gh-delta/commit/ca4f67378a32589f3a87e3fa5402771da9cb2d00))
* use present-tense npm install framing ([69a13b0](https://github.com/diegomarino/gh-delta/commit/69a13b06a4ff4a274afa3b47a759c74561797a3f))

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
