# gh-delta Contract

Canonical, machine-facing contract for `gh-delta`. Other docs link here; do not
duplicate these tables elsewhere (the one exception is the self-contained prompt
in `docs/watch-loop-prompt.md`).

This contract is stable while `report.schemaVersion === 2`. `report.schemaVersion`
identifies the report shape at runtime (see [Report Shape](contract/report.md#report-shape)); a
breaking change bumps it (see [schemaVersion policy](contract/schema-version.md#schemaversion-policy)). The
machine-readable form of this document is available at `gh-delta --help-json`.

A snapshot or durable log written by schema v1 (`meta.schemaVersion` absent, or
present but not `2`) is not migrated: reading it is a permanent `snapshot`/`log`
error hinting at `gh-delta reset` (see [`gh-delta reset`](contract/reset.md#gh-delta-reset)). There
is no automatic v1 → v2 upgrade path; re-baseline the monitor instead.

Read the page for your task. The links below also preserve earlier section bookmarks.

| Topic                                                                                                             | Reference                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| <a id="cli"></a>CLI                                                                                               | [Read](contract/cli.md#cli)                                                         |
| <a id="per-delta-templates"></a>Per-delta templates                                                               | [Read](contract/templates.md#per-delta-templates)                                   |
| <a id="project-setup-configuration-and-local-dx-commands"></a>Project setup, configuration, and local DX commands | [Read](contract/configuration.md#project-setup-configuration-and-local-dx-commands) |
| <a id="gh-delta-status"></a>gh-delta status                                                                       | [Read](contract/status.md#gh-delta-status)                                          |
| <a id="agent-output-schemas"></a>Agent output schemas                                                             | [Read](contract/agent-output.md#agent-output-schemas)                               |
| <a id="gh-delta-list"></a>gh-delta list                                                                           | [Read](contract/list.md#gh-delta-list)                                              |
| <a id="gh-delta-reset"></a>gh-delta reset                                                                         | [Read](contract/reset.md#gh-delta-reset)                                            |
| <a id="gh-delta-read"></a>gh-delta read                                                                           | [Read](contract/read-wait-cursor.md#gh-delta-read)                                  |
| <a id="gh-delta-wait"></a>gh-delta wait                                                                           | [Read](contract/read-wait-cursor.md#gh-delta-wait)                                  |
| <a id="gh-delta-cursor-set"></a>gh-delta cursor set                                                               | [Read](contract/read-wait-cursor.md#gh-delta-cursor-set)                            |
| <a id="run-registry"></a>Run Registry                                                                             | [Read](contract/registry.md#run-registry)                                           |
| <a id="exit-codes"></a>Exit Codes                                                                                 | [Read](contract/exit-codes.md#exit-codes)                                           |
| <a id="programmatic-api-surface"></a>Programmatic API Surface                                                     | [Read](contract/programmatic-api.md#programmatic-api-surface)                       |
| <a id="delta-classes"></a>Delta Classes                                                                           | [Read](contract/delta-classes.md#delta-classes)                                     |
| <a id="lifecycle-of-a-missing-item"></a>Lifecycle of a missing item                                               | [Read](contract/delta-classes.md#lifecycle-of-a-missing-item)                       |
| <a id="report-shape"></a>Report Shape                                                                             | [Read](contract/report.md#report-shape)                                             |
| <a id="delta-summary-schema"></a>Delta Summary schema                                                             | [Read](contract/summary.md#delta-summary-schema)                                    |
| <a id="opt-in-emitted-delta-enrichment"></a>Opt-in emitted-delta enrichment                                       | [Read](contract/enrichment.md#opt-in-emitted-delta-enrichment)                      |
| <a id="fingerprint-fields-from--to"></a>Fingerprint fields (`from` / `to`)                                        | [Read](contract/fingerprints.md#fingerprint-fields-from--to)                        |
| <a id="error-report-shape"></a>Error Report Shape                                                                 | [Read](contract/errors.md#error-report-shape)                                       |
| <a id="delta-log-and-cursors"></a>Delta Log and Cursors                                                           | [Read](contract/logs-and-cursors.md#delta-log-and-cursors)                          |
| <a id="snapshot-semantics"></a>Snapshot Semantics                                                                 | [Read](contract/snapshots.md#snapshot-semantics)                                    |
| <a id="fetch-limits-page-caps"></a>Fetch limits (page caps)                                                       | [Read](contract/snapshots.md#fetch-limits-page-caps)                                |
| <a id="measured-query-costs"></a>Measured query costs                                                             | [Read](contract/query-costs.md#measured-query-costs)                                |
| <a id="lock-semantics"></a>Lock Semantics                                                                         | [Read](contract/locks.md#lock-semantics)                                            |
| <a id="schemaversion-policy"></a>schemaVersion policy                                                             | [Read](contract/schema-version.md#schemaversion-policy)                             |
| <a id="platform-notes"></a>Platform Notes                                                                         | [Read](contract/platforms.md#platform-notes)                                        |
| <a id="outpost-payload-schema-v2"></a>Outpost Payload (schema v2)                                                 | [Read](contract/outpost.md#outpost-payload-schema-v2)                               |
| <a id="help-completeness"></a>Help Completeness                                                                   | [Read](contract/help.md#help-completeness)                                          |
| <a id="watch-directory-selection"></a>Watch-directory selection                                                   | [Read](contract/watch-selection.md#watch-directory-selection)                       |
