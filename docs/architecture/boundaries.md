# Product Boundaries

[Documentation](../README.md) · [Architecture by responsibility](../architecture.md)

`gh-delta` separates detection, delivery, and action:

- Detection is authoritative for local comparison and exit-code signals.
- Delivery is optional and best-effort through `--outpost-url`.
- Action planning and execution are always outside this package.

Given identical input snapshot and fetch results, detection output is
deterministic. Scheduling, retries around whole detector runs, queueing, and
downstream decisions belong to the caller.

## Boundaries

```mermaid
flowchart LR
    Sched[scheduler / watch loop] --> Bin[gh-delta.mjs]
    Bin --> CLI[lib/cli.mjs]
    CLI --> Run[cli/runner.mjs]
    Run --> Commands[cli/commands/*]
    Run --> Tick[cli/detector.mjs]
    Run --> Multi[cli/multi-repo.mjs]
    Run --> Render[cli/render.mjs]
    Run --> Out[lib/outpost.mjs]
    Run --> Config[cli/config.mjs]
    Commands --> Config
    Commands --> DX[lib/dx.mjs]
    Commands --> Tick
    Config --> ConfigCore[lib/config.mjs]
    Tick --> Parse[cli/parse.mjs]
    Tick --> Attention[cli/attention.mjs]
    Tick --> Details[cli/delta-details.mjs]
    Tick --> GH[lib/gh.mjs]
    Tick --> Snap[lib/snapshot.mjs]
    Tick --> Log[lib/deltalog.mjs]
    Tick --> Det[lib/detect.mjs] --> FP[lib/fingerprint.mjs]
    Tick --> Reg[lib/registry.mjs]
    Render --> Txt[lib/text-output.mjs]
    Commands --> Lst[lib/list.mjs]
    GH -. gh api graphql .-> GitHub[(GitHub GraphQL)]
    Out -. HTTP POST .-> Endpoint[(outpost endpoint)]
    Snap -. read/atomic write .-> FS[(snapshot file)]
    Log -. append/read/atomic cursor .-> FS
    Reg -. atomic breadcrumb write .-> RegFS[(run registry)]
    Lst -. read-only scan .-> FS
    Lst -. read-only scan .-> RegFS
```

The public CLI is one one-shot command. JSON output is for programs; text output
is for operator logs. Neither format creates schedules, timers, automations, or
wake-ups.

## Configuration and DX boundaries

`lib/config.mjs` is a pre-parse adapter for detector, wait, status, and the DX
commands, restricted to the public flags accepted by that command. It reads
local JSON configuration and environment defaults, then appends those existing
long flags; validation remains in the internal CLI modules, so flags and configuration
cannot drift into separate semantics or become explain positionals. No
configuration is present means no argv rewrite. `lib/dx.mjs` keeps `init`,
`doctor`, and `explain` policy testable:
init delegates the actual baseline to the existing detector, doctor reads only,
and explain delegates the semantic transition to `diffFingerprint`.
