# Watch Loop Use

[Documentation](../README.md) · [Usage by task](../usage.md)

`gh-delta` does not create timers. A scheduler should invoke one detector pass,
record the output, and stop.

The cron-oriented setup is:

1. Seed the baseline once with the same command the scheduler will use.
2. Run the command periodically under cron, systemd, CI, or an agent scheduler.
3. Treat exit `10` as "inspect deltas" and exit `1` as "retry later."
4. Avoid overlapping ticks against the same snapshot file; use scheduler-level
   locking if overlap is possible.

See [RUNBOOK.md](../../RUNBOOK.md) for the full scheduled-loop setup and
[watch-loop-prompt.md](../watch-loop-prompt.md) for a cron-owned prompt template.

Worked schedulers live in
[examples/](https://github.com/diegomarino/gh-delta/tree/main/examples) in the
source repository. Examples are GitHub documentation and are not shipped in the
npm package.
