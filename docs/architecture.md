# Architecture

`gh-delta` is intentionally narrow: it turns `(old snapshot, current GitHub
state)` into a categorized delta report. It does not schedule itself, open
browser sessions, merge pull requests, or send messages to workers.

The exact public contract lives in [docs/contract.md](contract.md). This
document explains the module boundaries, runtime flow, and rationale behind that
contract without duplicating the canonical tables.

Read the page for your task. The links below also preserve earlier section bookmarks.

| Topic                                                                                             | Reference                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| <a id="product-boundaries"></a>Product Boundaries                                                 | [Read](architecture/boundaries.md#product-boundaries)                                |
| <a id="boundaries"></a>Boundaries                                                                 | [Read](architecture/boundaries.md#boundaries)                                        |
| <a id="configuration-and-dx-boundaries"></a>Configuration and DX boundaries                       | [Read](architecture/boundaries.md#configuration-and-dx-boundaries)                   |
| <a id="failure-safety"></a>Failure Safety                                                         | [Read](architecture/runtime.md#failure-safety)                                       |
| <a id="runtime-flow"></a>Runtime Flow                                                             | [Read](architecture/runtime.md#runtime-flow)                                         |
| <a id="module-responsibilities"></a>Module Responsibilities                                       | [Read](architecture/modules.md#module-responsibilities)                              |
| <a id="internal-cli-modules"></a>Internal CLI modules                                             | [Read](architecture/modules.md#internal-cli-modules)                                 |
| <a id="package-surface"></a>Package Surface                                                       | [Read](architecture/modules.md#package-surface)                                      |
| <a id="monitor-identity"></a>Monitor Identity                                                     | [Read](architecture/identity-and-fetch.md#monitor-identity)                          |
| <a id="github-fetch-strategy"></a>GitHub Fetch Strategy                                           | [Read](architecture/identity-and-fetch.md#github-fetch-strategy)                     |
| <a id="snapshot-persistence"></a>Snapshot Persistence                                             | [Read](architecture/persistence.md#snapshot-persistence)                             |
| <a id="outpost-edge"></a>Outpost Edge                                                             | [Read](architecture/outpost-and-watch.md#outpost-edge)                               |
| <a id="future-entity-and-selector-research"></a>Future Entity and Selector Research               | [Read](architecture/outpost-and-watch.md#future-entity-and-selector-research)        |
| <a id="i-6-watch-selection-and-economical-polling"></a>I-6 watch selection and economical polling | [Read](architecture/outpost-and-watch.md#i-6-watch-selection-and-economical-polling) |
