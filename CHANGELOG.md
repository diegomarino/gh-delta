# Changelog

All notable changes to this package will be documented here.

This project follows semantic versioning.

## [0.7.0](https://github.com/diegomarino/gh-delta/compare/gh-delta-v0.6.1...gh-delta-v0.7.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* **watch:** watch entry JSON files may now carry an optional `ignoredTerminalAt` field. Existing entries remain valid unmodified; any tool reading watch entry files with a strict/exact-key expectation must be updated to tolerate this new optional key.
* **compact,text:** compact/ndjson delta records now include seq and firstObserved when the underlying delta carries them (previously silently dropped); a strict consumer validating against an exact key set must account for the two new optional fields.
* **fingerprint:** delta ids for checks rows that previously tied on name/kind/status/conclusion (distinguishable only by detailsUrl) will differ from prior 0.x output. This is a one-time churn for those rows only; existing contract-baseline fixtures were unaffected (no duplicate-tuple check rows in the recorded fixtures), so no baseline regeneration was needed.
* **compact,ndjson:** --format compact and --format ndjson now emit `detectedAt` instead of `at` in the report/end envelope.
* **contract:** report.schemaVersion and outpost payload schemaVersion are now 2. This is the schema-v2 epic's cumulative v1 -> v2 contract change, closing out what R1-R6 and F1-F4 built incrementally:
    - Snapshot items and delta from/to are `{fingerprint, context, meta}`,
      not one flat object; comparableFingerprint's 14-key drop-list and the
      ADDITIVE_COMPARED_FIELDS upgrade-compat list are gone -- every
      fingerprint key now participates in comparison and the delta id.
    - Fingerprint field names/casing changed throughout: ci/reviews/head/
      base/review/ciChecks/reviewSummary/threadDigest/threadStates/
      commentNodes/comments/commentsOverflow are replaced by
      checks/reviews/headSha/baseRef/reviewDecision/conversationComments/
      reviewComments, with lowercase enums; there are no more opaque
      digests.
    - The report is always the repos/results[] envelope (no single-repo
      bare shape, no top-level multi-repo errors array); filteredDeltas and
      warnings are always present; the timestamp field is `detectedAt`.
    - delta.title/author/url/headRefName are replaced by delta.context;
      delta.line and hideInternalDetails' public/private delta view are
      removed; delta.summary and delta.changed are always present.
    - Outpost payloads no longer duplicate delta fields at the root or
      emit eventId; delta fields live under `delta`, dedupe uses
      `delta.id`, and Standard Webhooks headers replace X-GhDelta-Signature.
    - A pre-schema-v2 (or otherwise invalid) snapshot or durable log is
      never migrated: it is a permanent error naming `gh-delta reset`.
* **classes:** a push with no other change now emits only `classes: ["head-changed"]`, not `["head-changed", "updated"]`. Any consumer relying on the forced pairing (or on `--ignore-classes updated` to avoid double-counting a push) must switch to matching `head-changed` directly. `context.title` on the missing lifecycle is now the real last-known title rather than always null.
* **examples:** this example receiver only understands the v2 outpost payload and Standard Webhooks signing; it no longer verifies X-GhDelta-Signature or reads v1's root-level delta fields.
* **outpost:** the outpost HTTP payload no longer duplicates delta fields at its root and no longer emits `eventId`; delta fields live under the new `delta` key, and dedupe must use `delta.id`. The X-GhDelta-Signature header is removed in favor of Standard Webhooks headers (webhook-id/webhook-timestamp/webhook-signature); receivers verifying the old header must migrate.
* **schema:** schema/json.json, compact.json, and ndjson.json now express the delta shape as $defs.delta + $ref instead of three inlined copies; consumers resolving these schemas must support $ref.
* **schema:** schema/json.json, compact.json, and ndjson.json no longer describe the old single/multi-repo split or the legacy delta field names; they describe the always-enveloped report and the context/changed/summary-always-on delta.
* **cli:** delta.title/author/url/headRefName are replaced by delta.context; delta.line is removed; delta.summary and delta.changed are now always present (previously opt-in/PR-only); delta.from/to are now compact/ndjson-optional (--full) rather than always omitted. The report drops the single-repo bare shape and the multi-repo top-level `errors` array in favor of an always-present `repos`/`results[]` envelope with per-repo errors; `filteredDeltas`/`warnings` are always present; the report timestamp field is renamed from `at` to `detectedAt`.
* **cli:** commentAuthorsIgnored is replaced by authorsIgnored, which also suppresses review-changed (via reviews[].author) and review-comments-added (via a pre-publish, double-opt-in-gated --enrich thread-replies call) when every attributable author is listed in --ignore-authors. review-changed is never suppressed when reviewDecision itself moved, even if a changed review row happens to belong to an ignored author -- that transition may not be explained by the changed row. Without --enrich thread-replies, or when every incremented thread is brand new (no prior baseline to diff replies against), a review-comments-added delta now fails open with an explicit warning instead of silently passing through unchecked. This is the one documented exception to opt-in enrichment quota being spent only after snapshot publication; see --help for --ignore-authors/--enrich.
* **contract:** DELTA_CLASSES gains review-comments-added and review-comments-removed; DELTA_DETAIL_FIELDS_BY_CLASS renames the new-comments/comments-removed detail field from comments to conversationComments, adds reviewComments for the two new classes, and replaces comments with conversationComments/reviewComments in updated's field list.
* **detect:** new-comments/comments-removed now fire only on conversationComments; a reply in an existing review thread instead fires the new review-comments-added/review-comments-removed classes, driven by the reviewComments compared field. Exports threadReplyIncrements, a pure per-thread reply-count-delta helper shared by --enrich thread-replies and the --ignore-authors pre-publish filter pass.
* **fingerprint:** prFingerprint/issueFingerprint no longer carry the aggregate comments field. PR fingerprints add reviewComments alongside the existing conversationComments; issue fingerprints keep conversationComments only. delta.id changes for any PR/issue whose comment counts differ from a prior snapshot taken before this change.
* **gh:** normalizePr/normalizeIssue no longer emit the aggregate comments field. PRs now emit conversationComments and reviewComments (= totalCommentsCount - conversationComments, clamped at 0) as independent values; issues keep conversationComments only.
* **fingerprint:** checks[] rows may gain runId/jobId fields, which enter the content-addressed delta.id (R2 put checks[] directly in the hashed identity), so ids for PRs with parseable Actions check URLs change from prior schema-v2 snapshots.
* **deltalog:** appendDeltaLog now requires non-empty repo/monitorId options, and every log record gains repo/monitorId fields. A durable log written before this change -- v1/v2 manifest, or pre-manifest raw NDJSON -- is rejected with an error naming `gh-delta reset`. There is no migration.
* **snapshot:** a snapshot missing meta, or whose meta.schemaVersion is not 2, is rejected with an error naming `gh-delta reset` as the recovery path. There is no migration from an older or meta-less snapshot.
* **gh:** lib/gh.mjs's fetchPRs, fetchIssues, fetchPRsByNumber, and fetchEnrichment now return `{ rows, rateLimit }` instead of a bare array; lib/enrich.mjs's enrichEmittedDeltas now returns `{ warnings, rateLimit }` instead of a bare warnings array. Any code importing these directly must destructure the new shape.
* **fingerprint:** fingerprint field names and enum casing change again (schema v2, following R1); every delta.id changes accordingly. Consumers reading ci/reviews/head/base/review/ciChecks/reviewSummary/threadDigest/ threadStates/commentNodes or uppercase enum values must update to checks/reviews/headSha/baseRef/reviewDecision and lowercase enums.
* **cli:** `--detail`/`--summaries`/agent-compact output, status items, and outpost payloads now read the three-section snapshot item shape (see the companion snapshot-split commit); a delta's `from`/`to` in every report format now carry `fingerprint`/`context`/`meta` instead of one flat object.
* **snapshot:** snapshot items and delta from/to are now `{ fingerprint, context, meta }` instead of one flat object. Delta ids change for every entity that carries a fingerprint field previously dropped before hashing (ciChecks, reviewSummary, ciDetails, reviewDetails, commentNodes, conversationComments, threadDigest, threadStates): these now participate in the content-addressed id. Persisted v1 snapshots are not compatible with this version; consumers reading raw snapshot files must update to the three-section shape.

### Features

* **cli:** add gh-delta reset; snapshot writes now carry full schema-v2 meta ([9bb865b](https://github.com/diegomarino/gh-delta/commit/9bb865bb18b32ff42bf62de0c11a96a5f69cc439))
* **cli:** authorsIgnored covers conversation, reviews, and thread replies ([0dfaad5](https://github.com/diegomarino/gh-delta/commit/0dfaad576fb1d0ea631b0f86b3086417201b5c5d))
* **cli:** unify delta and report shape for schema v2 (R3) ([e638a9c](https://github.com/diegomarino/gh-delta/commit/e638a9ca8c97078eccfd81eedf0566f643cec890))
* **compact,ndjson:** unify at -&gt; detectedAt with the JSON report ([83a3b8f](https://github.com/diegomarino/gh-delta/commit/83a3b8f4d7125ae211b3c70a460f2dd13d01f701))
* **contract:** bump schema version to 2, close the v1 compat surface ([994ca97](https://github.com/diegomarino/gh-delta/commit/994ca97dd60a35179b8d835fbbe1eab1032a99bc))
* **contract:** register review-comments-added/-removed classes ([5245366](https://github.com/diegomarino/gh-delta/commit/524536631f32b564d75b564b7640f5556dfd688e))
* **deltalog:** version-3-only manifest, log records carry repo/monitorId ([0bee0a9](https://github.com/diegomarino/gh-delta/commit/0bee0a92eddeea454736e8c12219d92680ae143a))
* **detect:** review-comments-added/-removed classes; new-comments is conversation-only ([7996313](https://github.com/diegomarino/gh-delta/commit/7996313b79b208acdb4ee03beeed739854a12e38))
* **enrich:** add thread-replies enrichment kind ([2a538a9](https://github.com/diegomarino/gh-delta/commit/2a538a9486fd4554c7060bd6dbb8e01909e7358b))
* **fingerprint:** drop digests, unify names/enums across checks/reviews/threads ([bd91971](https://github.com/diegomarino/gh-delta/commit/bd91971e157dc2e4491702258ec0c08111d0d5b6))
* **fingerprint:** parse runId/jobId from Actions check URLs, add summary.failedChecks ([afb0089](https://github.com/diegomarino/gh-delta/commit/afb0089fb307c5447361bfe29e5fc1df5cd63be9))
* **fingerprint:** reviewComments joins conversationComments as compared fields ([5e74f81](https://github.com/diegomarino/gh-delta/commit/5e74f81dfbb1c56942c6f5a8e2a4371d8c475a60))
* **gh,cli:** item context (id/author/createdAt/url) and --enrich body ([b7ae6e7](https://github.com/diegomarino/gh-delta/commit/b7ae6e77961735b4d1edd4d9352000bcfececc9b))
* **gh,cli:** item context (id/author/createdAt/url) and --enrich body (F2) ([a579c5b](https://github.com/diegomarino/gh-delta/commit/a579c5bdfa958374fb8dffeeb42d4a3e191a0bff))
* **gh:** add fetchThreadReplies, one aliased per-thread GraphQL call ([3e2f18b](https://github.com/diegomarino/gh-delta/commit/3e2f18bbeb83b954a4b78b495f1765f5413590c4))
* **gh:** instrument every GraphQL query with rateLimit cost tracking ([8115288](https://github.com/diegomarino/gh-delta/commit/811528830914c8c0a1e537f71860e3c1b827207e))
* **gh:** split PR conversation and review comment counts ([15f7ee6](https://github.com/diegomarino/gh-delta/commit/15f7ee6cad6e0af72fee2f55b095fe38f48f244d))
* **outpost:** reshape delta payload and switch to Standard Webhooks signing ([b48b808](https://github.com/diegomarino/gh-delta/commit/b48b808ae8bac6fbb4bbc3890e27d0f402d8915e))
* **schema:** regenerate json/compact/ndjson schemas for the v2 delta/report shape ([163a73b](https://github.com/diegomarino/gh-delta/commit/163a73bdc8e4af7fa30ee97f03f6ae337c108794))
* **snapshot:** make snapshot meta mandatory (schema v2) ([55e17e6](https://github.com/diegomarino/gh-delta/commit/55e17e68e27717a199fa1d7d1344155f52287161))
* **snapshot:** split snapshot items into fingerprint/context/meta ([a4fb6f4](https://github.com/diegomarino/gh-delta/commit/a4fb6f41df8226a17a2499c5c4825eb81ded98dc))
* **watch:** persist ignored terminal transitions to close the sticky-filter hole ([7207a8f](https://github.com/diegomarino/gh-delta/commit/7207a8fea670c79d9fd0a286c5b9499d93c7b3a8))


### Bug Fixes

* **classes:** decouple head-changed from updated, carry real missing-cycle titles, add firstObserved ([db842b9](https://github.com/diegomarino/gh-delta/commit/db842b96024c9d53fb644e9be39fd610541f7394))
* **cli:** read the schema-v2 three-section item shape everywhere ([33095d7](https://github.com/diegomarino/gh-delta/commit/33095d70f46f069a382b3d2c98d4de158f989eac))
* **cli:** repair the cli.mjs/wait.mjs detector-tick error paths ([f2f32a5](https://github.com/diegomarino/gh-delta/commit/f2f32a59823d060af0d44e6e1370d5b9dd4147c3))
* **cli:** require full author coverage before suppressing review-comments-added ([f9cacdd](https://github.com/diegomarino/gh-delta/commit/f9cacddc6df1dafb32830ed14b8d8b50f4c082ba))
* **compact,text:** propagate seq/firstObserved to agent formats, show title/author in status text ([dbd7a66](https://github.com/diegomarino/gh-delta/commit/dbd7a66454c6cbc276a7ee005e9988d18293ac63))
* **contract-fields:** derive REGISTRY_ENTRY_FIELDS from real registerMonitor output ([a002b22](https://github.com/diegomarino/gh-delta/commit/a002b22bb9514888fe348a2ceaa9b05ed7315c83))
* **contract:** correct stale AGENT_COMPACT_*/AGENT_NDJSON_END_FIELDS ([3b8bda3](https://github.com/diegomarino/gh-delta/commit/3b8bda345d767410b2f88d220fdbdcc7df430055))
* **contract:** cover every field catalog with real-output drift detection ([60551fd](https://github.com/diegomarino/gh-delta/commit/60551fd90dff3e884361f6c4f1524b9e504c7675))
* **deltalog:** resetDeltaLog recovers dataFile from an invalid-but-parseable manifest ([758afa9](https://github.com/diegomarino/gh-delta/commit/758afa9929f44ec4fca2ac11d43cce351260bf73))
* **diff:** align checksDiff with diffSummaries on duplicate check names, exclude recentComments rotation from updated ([3fd8ac1](https://github.com/diegomarino/gh-delta/commit/3fd8ac104dd3c92a815f1980bc91d5e0f325c4f6))
* **diff:** checksDiff opaque fallback only fires on a real change ([bf478b3](https://github.com/diegomarino/gh-delta/commit/bf478b351a0887b8f04f5662a3a341bca83ee5ce))
* **examples,tools:** repair broken examples and contract-violating generated output (W7B) ([06d77cc](https://github.com/diegomarino/gh-delta/commit/06d77cc7d582dc12d82ff17705586687637c0643))
* **examples:** fix v2 field mapping in programmatic-embed example ([b0a15cb](https://github.com/diegomarino/gh-delta/commit/b0a15cba3282f1c4f418382273f9e0f7311e0464))
* **examples:** read coordinator logFile from results[], not top-level ([fa9eacc](https://github.com/diegomarino/gh-delta/commit/fa9eacc2fc31063e4fd74bba0fa222eb6ae8942e))
* **fingerprint:** give buildChecks a unique sort tiebreaker ([97b683f](https://github.com/diegomarino/gh-delta/commit/97b683f19ef32135fff62846d1107611680f5e0a))
* gh-delta init reads init baseline/stateFile from v2 results[0] ([25c7873](https://github.com/diegomarino/gh-delta/commit/25c7873ee1365bf294759737f2a011869be87dac))
* **gh:** anchor fetchThreadReplies against the observed thread state ([d21ba5c](https://github.com/diegomarino/gh-delta/commit/d21ba5caa6fe3a9997d6e8384502ec27069ba1c8))
* **outpost:** normalize a raw detectDeltas() delta before building its payload ([5a526fb](https://github.com/diegomarino/gh-delta/commit/5a526fba9657cdefca6a4660324f69093c6cd064))
* post-epic cleanup lane A — release blocker, wait bug, at→detectedAt (W7A) ([b5321a1](https://github.com/diegomarino/gh-delta/commit/b5321a175aa5b034e0a3b3c466b308229cfa03ec))
* read v2 results[0].baseline in the live playground e2e, widen the sweep ([eae7b3c](https://github.com/diegomarino/gh-delta/commit/eae7b3cf267cde40b73cabaca8cb6b24bd8a3f20))
* resolve confirmed Codex review findings from the schema-v2 epic (code) ([24ccaca](https://github.com/diegomarino/gh-delta/commit/24ccaca7d4995bfdbe1626c70d85b7ce08c40596))
* **schema:** share one $defs.delta across json/compact/ndjson via $ref ([a6080d7](https://github.com/diegomarino/gh-delta/commit/a6080d72ff5d508f0a99caec66f5f064aaccf120))
* **test:** make schema-coverage's compact/ndjson checks self-policing ([836b86e](https://github.com/diegomarino/gh-delta/commit/836b86e3a82a565995113f919d560166dd18b6a3))
* **test:** render and validate multi-repo output in every agent format ([cc10b08](https://github.com/diegomarino/gh-delta/commit/cc10b0813a2b7e9ae0cd9c8a5d805aefe13c9c90))
* **test:** stop writing real detector ticks into the developer's registry ([6e14af5](https://github.com/diegomarino/gh-delta/commit/6e14af59b3db170d160f8b3a35d50c9e98f327d7))
* **tools/examples:** enrich deltas before the fixture strip step ([4b76954](https://github.com/diegomarino/gh-delta/commit/4b769546f710fc203e636004df0a2b10bde35342))
* **wait:** make --from-log --until-summary actually match ([f51092b](https://github.com/diegomarino/gh-delta/commit/f51092ba16896da72ad7ad66fab84a1ce1adf885))
* **wait:** repoint state-file lookups at results[].stateFile ([a07ea00](https://github.com/diegomarino/gh-delta/commit/a07ea0020067a7b342cac14a29b16e719f86774e))
* **wait:** report the highest-severity error, not the last one collected ([21bffa2](https://github.com/diegomarino/gh-delta/commit/21bffa2ad8e88bcb8ec3e750a5bd94f528c3b6f0))
* **watch:** clean up entries by terminal state, not delta class ([9b302f7](https://github.com/diegomarino/gh-delta/commit/9b302f7ce0548ca63ba6091387406df02535995e))
* **watch:** clean up entries by terminal state, not delta class ([d3f3ed3](https://github.com/diegomarino/gh-delta/commit/d3f3ed36c3c1fddaaaeb71a97e1ce0cbc759280c)), closes [#57](https://github.com/diegomarino/gh-delta/issues/57)
* **watch:** derive marker suppression from real filter output, not flags ([a6d0fe0](https://github.com/diegomarino/gh-delta/commit/a6d0fe0daf89944806b554528d3dd15ce9d17b9b))
* **watch:** fail the tick on a concurrent watch-entry replacement ([5444769](https://github.com/diegomarino/gh-delta/commit/5444769aad889c7214fdfb0ae81ab1ebdf1be83c))
* **watch:** hold the entry lock through mark AND publish, not just the mark ([95497b4](https://github.com/diegomarino/gh-delta/commit/95497b491ed8e0469958538ca4d2eead0ed1b4d4))
* **watch:** move unsafe lock helpers off the published API surface ([3462db6](https://github.com/diegomarino/gh-delta/commit/3462db6ee41ee89166ebc4ab78cf95a221189536))
* **watch:** persist ignoredTerminalAt before publication, not after ([68fe707](https://github.com/diegomarino/gh-delta/commit/68fe707579e8f38415578daa5db51bffd037b607))
* **watch:** recognize an already-terminal from.state as cleanup-eligible ([c3b357a](https://github.com/diegomarino/gh-delta/commit/c3b357a7c5c5fe474a156f147164f01960fd521f))
* **watch:** require a surviving terminal class before cleaning up a watch entry ([2d2396f](https://github.com/diegomarino/gh-delta/commit/2d2396f7efe5b34fd71c665a6f7a5f1a3a0d484f))
* **watch:** size the entry lock lease from --lock-stale-ms, not --gh-timeout-ms ([12d46aa](https://github.com/diegomarino/gh-delta/commit/12d46aa1ac282092a1756022afef4e7431696a0f))
* **watch:** size the entry lock lease from a fixed constant, not --lock-stale-ms ([66833be](https://github.com/diegomarino/gh-delta/commit/66833be0def02ba3478c782f70dc3466be8a6337))
* **watch:** treat a terminal first observation as cleanup-eligible ([894ff3c](https://github.com/diegomarino/gh-delta/commit/894ff3c635de2d2c40cfda2577ba8d2dc6333289))
* **watch:** use from.state !== to.state for transitions, not terminal-priorState ([c5da9be](https://github.com/diegomarino/gh-delta/commit/c5da9be39ede4a50637d7c55ca9a13089111feee))


### Documentation

* add missing --enrich/--full and gh-delta reset coverage (gaps, no v2 doc home) ([c4dd79f](https://github.com/diegomarino/gh-delta/commit/c4dd79f3170e9c3659b2cbbaa37368eb151d3346))
* **args:** stop describing repo-casing normalization via the removed eventId ([0ad352f](https://github.com/diegomarino/gh-delta/commit/0ad352f1e29a54dabae6ae27cf2e6eb50ec83c2f))
* bring prose in line with schema v2 (W7C) ([3aa02f9](https://github.com/diegomarino/gh-delta/commit/3aa02f99ae013536a9b9fdf4cc82b92e5c650be2))
* **contract,help:** rewrite contract.md for schema v2 ([520b22b](https://github.com/diegomarino/gh-delta/commit/520b22b2c1f55a2dac625134ee652424013d0429))
* **contract:** fix stale manifest/log docs and internal v2 contradictions ([8c53b70](https://github.com/diegomarino/gh-delta/commit/8c53b704a5e565e2ab92c863346087cbdfdc865c))
* **contract:** fix the from/to bare-fingerprint self-contradiction ([e6e88d7](https://github.com/diegomarino/gh-delta/commit/e6e88d7e444c3396e7170be50a5aa1b88dc6adcf))
* **examples:** add a review-comments-added example delta, regenerate SVGs ([428598e](https://github.com/diegomarino/gh-delta/commit/428598e683fc54b24f0f0a4df173bc7b2ff92238))
* **examples:** fix stale v1 references in examples and generator docs ([9f27dd0](https://github.com/diegomarino/gh-delta/commit/9f27dd0c2739cbbd67ff5ed062f70d33f86927af))
* **examples:** migrate outpost-ntfy-receiver to Standard Webhooks and the v2 payload ([87b49c3](https://github.com/diegomarino/gh-delta/commit/87b49c302ea12d82f9e212e8db0dc2926411b440))
* **examples:** update fixtures and cast generator to the v2 item shape ([a69a2d2](https://github.com/diegomarino/gh-delta/commit/a69a2d20153f54c0039368aa7e431da1ee9a5c07))
* **examples:** update fixtures and demo runner to the v2 fingerprint shape ([abb782d](https://github.com/diegomarino/gh-delta/commit/abb782d27c602ef8fb2cbf53b6a942b967146b92))
* **examples:** update fixtures and the GitHub Actions example for schema v2 ([35de99f](https://github.com/diegomarino/gh-delta/commit/35de99f52ada5f0eb022632a53dc9eb3d907205e))
* **fingerprint:** fix stale drop-list comments left over from schema v2 ([0af8758](https://github.com/diegomarino/gh-delta/commit/0af87581c69ec201d6437d88cc6e2101ed5c60f7))
* fix dead outpost-v1 anchors, stale --summaries usage, new-comments scope ([7755f13](https://github.com/diegomarino/gh-delta/commit/7755f13b1f3c7f610dab04b1c4b3225fb1ad3226))
* fix reset --entities omission, dead v1 anchor, import comment, enrich cost ([d80e62e](https://github.com/diegomarino/gh-delta/commit/d80e62e23cdeeebd5337a420785e5c1130a72570))
* fix v1-era field names, --summaries no-op, and add gh-delta reset recovery ([b0e3243](https://github.com/diegomarino/gh-delta/commit/b0e32436c3b9555fb96205282c9cad41f5532256))
* **help,text-output:** document thread-replies, review-comments-*, and the pre-publish quota exception ([4dbeac4](https://github.com/diegomarino/gh-delta/commit/4dbeac43aecb79c86a0136c35692de9233fafac9))
* **help:** document the v2 delta/report shape and the new --full flag ([014fffc](https://github.com/diegomarino/gh-delta/commit/014fffc6cd3edbc9b607fc2d3778a843efd8fac1))
* **help:** document the v2 outpost payload shape and dedupe rule ([981a5ad](https://github.com/diegomarino/gh-delta/commit/981a5ad737aa12902af92589694d7f5013d90eda))
* **lib:** fix stale schema-v2 comments and prose ([4836b21](https://github.com/diegomarino/gh-delta/commit/4836b21ce9b862ae0cd408ff017c2e10f7661061))
* record F1's measured reviewThreads.comments query cost (8/8, not 7/8) ([17ab7a3](https://github.com/diegomarino/gh-delta/commit/17ab7a3605673f5b7070e2a09ad2caafbebad9fb))
* resolve confirmed Codex review findings (docs) ([6d44056](https://github.com/diegomarino/gh-delta/commit/6d44056a3e60e4b45ca31c5ec139f4fc77a1ddb9))
* **runbook:** cover --watch-dir monitors in the reset recovery flow ([fcd38d7](https://github.com/diegomarino/gh-delta/commit/fcd38d7c7dad72ee7fae769956ffccb700d873fa))
* **runbook:** fix outpost v2 payload/dedupe, summaries no-op, class table gaps ([62b5d2e](https://github.com/diegomarino/gh-delta/commit/62b5d2e0458dba47b29afed6a5b4860dc6bf2d0e))
* **watch-loop-prompt:** drop obsolete head-changed/updated pairing advice ([4d24717](https://github.com/diegomarino/gh-delta/commit/4d2471780f3b8b07f1e597db3cd7d35f87988383))

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
