# systemd timer

Classic Linux ops: a user-level timer owns the clock, journald keeps the tick
logs the RUNBOOK asks you to keep, and gh-delta's **exit taxonomy maps onto
systemd unit states** — only a permanent configuration error trips the
failure path.

```
gh-delta-watch.timer (OnCalendar=*:0/5)
   │
   ▼
gh-delta-watch.service ── one tick, --format text ──> journald
   │  SuccessExitStatus=1 10
   │  exit 0/1/10  -> unit "success" (deltas + transient errors are normal)
   │  exit 2       -> unit FAILED
   ▼
OnFailure= gh-delta-alert.service ──> journald (err) + best-effort notify-send
```

## Install

```bash
mkdir -p ~/.config/systemd/user ~/.local/state/gh-delta
cp gh-delta-watch.service gh-delta-watch.timer gh-delta-alert.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/gh-delta-watch.service   # set OWNER/NAME
systemctl --user daemon-reload
systemctl --user enable --now gh-delta-watch.timer
journalctl --user -fu gh-delta-watch                    # watch the ticks
```

## Design notes

- **`SuccessExitStatus=1 10`** is the whole trick: deltas (`10`) are a normal
  outcome, transient errors (`1`) are the next tick's problem, and only a
  permanent error (`2` — bad flags, unreadable snapshot) fails the unit and
  fires `OnFailure`. See [exit codes](../../docs/contract.md#exit-codes).
- **The blind spot, on purpose**: a _sustained_ run of exit-1 ticks (broken
  `gh` auth, long rate-limit) stays "success" and never alerts. Spot it in the
  journal: `journalctl --user -u gh-delta-watch --since -1h | grep 'gh-delta error'`.
  If you want an alarm for that, wrap the ExecStart in a script that counts
  consecutive failures — deliberately out of scope here.
- **`Persistent=false`**: no catch-up fire after suspend; the snapshot horizon
  makes the next regular tick cover the gap.
- **Alerts**: journald at `err` priority is the reliable channel;
  `notify-send` only reaches desktop sessions and is best-effort.

## Requirements

Linux with systemd (user session), `gh` authenticated for the user, gh-delta
on `~/.local/bin` (or adjust `ExecStart`). Validate edits with
`systemd-analyze --user verify gh-delta-watch.service`.
