# Troubleshooting / FAQ

Common failure symptoms, causes, and fixes for `gh-delta` operators.

**My monitor re-baselined after a reboot.**
The temp-dir default (`<system temp dir>/gh-delta-<user>/...`) is ephemeral by
design — the OS may clear `/tmp` on reboot or on schedule. When the snapshot
file is gone, the next run seeds a fresh baseline: `baseline: true` in the JSON
report (or the baseline line in text mode) is the signal. If you need durable
state that survives reboots, pass `--state-dir` pointing at a persistent
directory. Agent loops and casual CLI runs that can tolerate post-reboot
re-baselines are fine with the default.

**Where is my snapshot file?**
The report's `stateFile` field always echoes the resolved path — check that
field first. `<system temp dir>` is `/tmp` on Linux and `/var/folders/…/T` on
macOS; `os.tmpdir()` resolves differently per platform, so the `stateFile` echo
is the authoritative answer.

**`gh` is not authenticated — exit `1` on first run.**
Run `gh auth status` to verify authentication. `gh-delta` delegates all GitHub
fetches to the `gh` CLI. If `gh` is not authenticated or lacks read access to
the repository, the detector exits `1` and does not touch the snapshot. Fix
authentication first, then retry.

**"exceeded N pages — narrow the monitor scope or re-seed the baseline".**
The tool fails closed (exit `1`) rather than silently truncating results.
Open items are limited to 1 000 per family (10 pages × 100). Updated items per
tick are limited to 3 000 (30 pages × 100); the guidance is to narrow the
monitor scope or re-seed the baseline. Per-item nested pagination (CI contexts,
reviews, review threads, labels) also fails closed if a sub-page overflows.
Narrow the monitor scope (a tighter `--entities` selection, watch a fork, or
split into multiple monitors) before continuing.

**The same delta refires every tick.**
If `gh-delta` repeatedly reports the same delta on every scheduled run, stop
and investigate the underlying GitHub state before taking any action. If an item
has been absent for 3 consecutive ticks, it is demoted to `presumed-deleted` and
goes silent — no further ticks will mention it unless it reappears. Repeated
firing before that demotion is a signal that something unexpected is happening on
the GitHub side or in your monitor configuration.

**An issue I deleted showed `missing` → `still-missing` → `presumed-deleted` — is that a bug?**
No, that is expected behavior. `missing` (tick 1) and `still-missing` (tick 2)
are warnings that an open item vanished from the fetch. `presumed-deleted` (tick 3) is the terminal class — it fires once and then the object goes silent with
memory intact. If the item reappears, `reappeared` fires. If it is truly gone,
silence is correct. You can verify on GitHub; no further action is required from
the monitor.

**Corrupt snapshot / invalid JSON — exit `2`, snapshot not updated.**
If the snapshot file is invalid JSON or has an unrecognized shape, `gh-delta`
exits `2` (permanent error) and leaves the file untouched to preserve monitor
memory. Do not hand-edit snapshot files. If recovery is needed, delete the
snapshot and re-seed the baseline with a fresh first run.

**Snapshot file grows over time on a long-lived monitor.**
Snapshot files retain dormant closed items and archived `presumed-deleted`
fingerprints indefinitely by design — this is what preserves monitor memory
and prevents reappearing items from being treated as new. On very long-lived
active monitors the file grows slowly as new items accumulate. Deleting the
snapshot and re-seeding the baseline is the reset; the next run will treat all
current open items as new.
