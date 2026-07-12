# docs/ — Index

One-screen map of this tree. Start with the canonical contract if you only
read one file.

## Canonical contract (read this first)

- [`contract.md`](contract.md) — the machine contract / single source of
  truth: CLI flags, `list`, run registry, exit codes, report/summary/
  fingerprint shapes, delta classes, snapshot semantics. Everything else
  links back here.

## Using gh-delta

- [`usage.md`](usage.md) — practical recipes: install modes, baseline/repeat
  runs, snapshot identity, `list`, watch loops, outpost, programmatic use.
- [`troubleshooting.md`](troubleshooting.md) — operator runbook: re-baseline,
  snapshot location, registry, auth, page caps, recovering from errors.
- [`watch-loop-prompt.md`](watch-loop-prompt.md) — copyable prompt template
  for running gh-delta as an agent/cron tick.

## Maintaining gh-delta

- [`architecture.md`](architecture.md) — module boundaries, control flow,
  fetch strategy, persistence, diagrams for maintainers.
- [`release-checklist.md`](release-checklist.md) — pre-publish local gate and
  package-contents checklist.

## Positioning

- [`alternatives.md`](alternatives.md) — how gh-delta compares to adjacent
  tools, for evaluators.

## Research reference

- [`entities-research/`](entities-research/) — dated, shipped research notes
  on GitHub entities gh-delta doesn't watch yet (not a contract; see its own
  README for scope and promotion checklist).

## Not part of the shipped docs

`docs/audits/` and `docs/superpowers/` are gitignored, local-only session and
process artifacts (point-in-time audit reports and internal implementation
plans). They are not tracked in git and do not ship — if you don't have them
locally, that's expected.
