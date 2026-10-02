# gh-delta read

[Documentation](../README.md) · [Contract reference](../contract.md)

```
gh-delta read --cursor <path>
  [--only-classes <classes>] [--number <positive integer>]
  [--advance] [--format json|text|template]
  [--template <text> | --template-file <path>] [--template-sha256 <hex>]
```

Reads only the existing cursor-bound log: no GitHub call, snapshot read/write,
lock, or registry access. `--only-classes` accepts known `DELTA_CLASSES`; `--number`
filters GitHub item number, not result count. It always scans complete records to
EOF, so `cursor.to` includes entries rejected by consumer filters. Without
`--advance` the cursor bytes are unchanged; with it, the cursor is atomically set
to that scanned tail after the report is assembled. Exit `10` means returned
`deltas` is nonempty. A missing cursor, invalid cursor, or malformed complete log
record is `kind: "log"` / exit `2`; a missing log is empty only at cursor seq `0`.

## gh-delta wait

```
gh-delta wait --timeout <duration>
  [--until <classes>] [--until-summary <field=value[,value...]>]
  [--interval <duration>] [--max-interval <duration>] [--backoff <positive number>]
  [--settle <duration>] [--heartbeat-file <path>] [--progress]
  [--from-log --cursor <path>]
  [detector options]
```

`wait` supports only `--format json`; agent compact and NDJSON envelopes do not
carry the wait command's required `reason` and `iterations` fields. `wait`
rejects `--omit-end` as an unknown option even when detector configuration
enables omit-end.

`wait` is a bounded worker loop. It runs a normal detector tick per iteration,
so snapshots advance and each state-file lock is acquired and released within
that iteration; it is never held while sleeping. `--timeout` is required.
`--until` matches a future emitted delta class. By contrast, `--until-summary`
tests the current normalized PR summary on the first iteration too: an already
matching state exits `10` with `reason: "already-satisfied"`. Values after `=`
are alternatives, so `ciRollup=failed,green` matches either state. A matching
future delta exits `10` with `reason: "until"`; expiry exits `0` with
`reason: "timeout"`.
`--settle` keeps polling and accumulating after the first match until its
settle deadline (or SIGTERM), so checks that complete together are delivered in
one report.

The final JSON report has `command: "wait"`, the resolved `repo` (or aggregate
`repos`) and `monitorId` when a detector tick ran, accumulated `deltas`,
`iterations`, `reason`, and a human-only `summary`. A tick or heartbeat failure
uses the standard error envelope instead; successful reasons are only `until`,
`already-satisfied`, `timeout`, or `signal`.
`--heartbeat-file` exists before the first tick and is touched once per
completed iteration; its default is `<stateFile>.hb`, or `<cursor>.hb` for
`--from-log`. `--progress` writes one NDJSON `{type:"tick",at,deltas}` record
to stderr immediately after each completed iteration and leaves stdout solely
for the final report. `--from-log` requires `--cursor` and repeatedly uses the
local durable log reader instead of running detector ticks: it never invokes
GitHub. Its `--number` filter is passed to the log reader, and
`--until-summary` is derived from each logged delta's `to` fingerprint, never a
previously rendered summary. Wait rejects every `--outpost-*` flag. `SIGTERM`
stops after the current iteration, prints the accumulated report, and exits `0`
with `reason: "signal"`.

### gh-delta cursor set

```
gh-delta cursor set <cursor-path> <seq> [--log-file <path>] [--format json|text]
```

Initializes a missing cursor only with `--log-file` (normalized absolute). An
existing cursor stays bound to its log; a supplied `--log-file` must match. `seq`
is a non-negative safe integer and may move backwards for replay, but cannot be
above the complete log tail. A missing log permits only seq `0`. Success is exit
`0`; cursor replacement is atomic.
