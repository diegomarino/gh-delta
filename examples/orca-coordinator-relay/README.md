# Orca coordinator relay

A worked example of wiring gh-delta to an agent: a Claude Code **coordinator**
runs inside an [Orca](https://github.com/stablyai/orca) terminal orchestrating
worker agents; this relay makes GitHub changes reach it without a human
copy-pasting them.

```
GitHub (PR/issue comments, reviews, CI flips, state changes)
   │  cron, every 2 min
   ▼
gh-delta  ── one deterministic tick; exit 10 = deltas
   │
   ▼
gh-delta-orca-relay ── resolves the coordinator's terminal handle live
   │                    (Orca terminal whose worktreePath == the main checkout)
   ▼
coordinator TUI: "(gh-delta relay) GitHub changed: PR #93 +1 review comment…"
```

The division of labor follows gh-delta's design: the loop is a **dumb
deterministic detector**, the **agent decides** what the delta means. The relay
adds no policy of its own — the coordinator's operating brief already mandates
what to do with new review comments (answer + resolve threads before packaging
a merge gate).

## Install

```bash
ln -s "$(pwd)/gh-delta-orca-relay" ~/.local/bin/gh-delta-orca-relay
chmod +x gh-delta-orca-relay
crontab -e   # one line per project:
# */2 * * * * $HOME/.local/bin/gh-delta-orca-relay /path/to/main-checkout
```

Everything else is derived at runtime: repo from the checkout's `origin`
remote, snapshot `--monitor-id` from the repo name, coordinator handle from
`orca terminal list`.

## Design notes

- **State defaults to `/tmp` deliberately** (`GH_DELTA_RELAY_STATE`
  overrides). After a reboot there is no coordinator terminal to relay to, and
  a freshly launched coordinator re-sweeps PR/issue ground truth per its own
  operating brief — so the correct post-reboot behavior is a silent baseline
  re-seed, not a delta flood into a log nobody reads. While cron runs, ticks
  touch the snapshot every interval, so periodic `/tmp` cleanup never reaps a
  live baseline.
- **No coordinator → drop, exit 0.** Deltas are recorded in
  `relay-<repo>.log`; cron never sees an error. The relay trusts the
  coordinator's session-start sweep to cover anything missed while it was
  down.
- **Text into the TUI, not a typed orchestration message.** Typing into the
  coordinator's composer requires zero changes to its message-protocol
  contract; it reads the line like any human steer. If you prefer typed
  messages (`orca orchestration send --type github_delta`), the coordinator's
  supervision loop must also be taught to `--types … ,github_delta`.
- **Self-echo:** the coordinator's own PR comments come back as deltas one
  tick later; the relayed line tells it to ignore deltas caused by its own
  just-posted comments.
- **Exit taxonomy:** only exit `10` relays. Exit `1` (transient: network, gh,
  timeout) is logged and left for the next tick; exit `2` (permanent: bad
  flags or unreadable snapshot) is logged loudly — it will refire every tick
  until a human fixes it, so grep the relay log for `PERMANENT` when a monitor
  goes quiet. Neither ever types into the coordinator's TUI.

## Requirements

`gh` (authenticated), `node`, `jq`, `orca` CLI, and a gh-delta checkout at
`~/Dev/gh-delta` (adjust the path inside the script if yours differs).
