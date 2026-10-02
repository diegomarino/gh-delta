# Documentation map

Choose the task you need. Humans and agents use the same topic pages;
contracts define exact behavior, guides show workflows, and architecture
explains the implementation.

| I need to…                                    | Read                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Install and run gh-delta                      | [Installation](guides/installation.md)                                                            |
| Create a durable monitor                      | [First monitor](guides/first-monitor.md)                                                          |
| Observe selected PRs, issues, or a mixed list | [Watch selection](guides/watch-selection.md)                                                      |
| Observe several repositories                  | [Multiple repositories](guides/multiple-repositories.md)                                          |
| Schedule recurring observations               | [Scheduled tick](operations/scheduled-tick.md) and [scheduler choices](operations/schedulers.md)  |
| Share observations with independent consumers | [Log replay](guides/log-replay.md)                                                                |
| Choose output or enrich deltas                | [Output](guides/output.md) and [enrichment](guides/enrichment.md)                                 |
| Format a notification line                    | [Template examples](template-examples.md)                                                         |
| Deliver observations to an endpoint           | [Outpost guide](guides/outpost.md)                                                                |
| Integrate the library or change a public API  | [Programmatic guide](guides/programmatic-use.md) and [API contract](contract/programmatic-api.md) |
| Diagnose an error                             | [Troubleshooting](troubleshooting.md) and [error contract](contract/errors.md)                    |
| Understand or change internals                | [Architecture map](architecture.md)                                                               |
| Find an exact rule, field, or exit code       | [Contract index](contract.md)                                                                     |

## Canonical contract

[`contract.md`](contract.md) indexes the machine contract and single source of
truth: CLI flags, `list`, run registry, exit codes, report/summary/fingerprint
shapes, delta classes, and snapshot semantics. Other docs link to the relevant
contract page. Read only the topics required for your task.

## Using gh-delta

- [Usage index](usage.md): install modes, baseline/repeat runs, snapshot identity,
  `list`, watch loops, outpost, and programmatic use.
- [Operating procedures](../RUNBOOK.md): baseline, cron tick, scheduler choices,
  delivery, delta interpretation, and operating rules.
- [Troubleshooting](troubleshooting.md): re-baseline, snapshot location, registry,
  authentication, page caps, and recovery.
- [Agent recipes](recipes.md): short situation-to-command decisions.
- [Watch-loop prompt](watch-loop-prompt.md): self-contained prompt for an agent or cron tick.
- [Runnable examples](https://github.com/diegomarino/gh-delta/blob/main/examples/README.md):
  integration examples kept with their files in the repository; not shipped in npm.
- [Agent skill](../skills/gh-delta/SKILL.md): monitoring intent, invariants, and
  task-specific procedures. Its bundled references also work when installed separately.

## Maintaining gh-delta

- [Architecture](architecture.md): module boundaries, control flow, fetch strategy,
  persistence, and diagrams for maintainers.
- [Release checklist](release-checklist.md): pre-publish local gate and package contents.
- [Query-cost measurements](query-cost-measurements.md): recorded observations and provenance.

## Positioning

[Alternatives](alternatives.md) compares gh-delta with adjacent tools for evaluators.

## Research reference

[Entity research](entities-research/README.md) contains dated, shipped notes on
GitHub entities gh-delta does not watch yet. These notes are not a contract;
read the research scope and promotion checklist before using them.

## Not part of the shipped docs

`docs/audits/` and `docs/superpowers/` are gitignored, local-only session and
process artifacts (point-in-time audit reports and internal implementation
plans). They are not tracked in git and do not ship — if you do not have them
locally, that is expected.
