# Project setup, configuration, and local DX commands

[Documentation](../README.md) · [Contract reference](../contract.md)

`gh-delta init` resolves the current repository (or accepts `--repo`), uses a
durable `--state-dir` (default `.gh-delta` in the checkout), performs one normal
baseline, then atomically creates `.gh-delta.json` only when it did not already
exist. It never overwrites configuration and rejects a temporary state directory.
Its `nextCommand` is `gh-delta`; `--agent` only prints cron, systemd, and prompt
snippets—it never installs a scheduler.

For detector, wait, status, and DX commands, configuration is loaded from
project `.gh-delta.json` then `~/.config/gh-delta/config.json`; only the
existing long flags accepted by that command are applied (so configuration never
supplies a positional). Keys are exactly existing long flag names
(for example `"state-dir"`, `"monitor-id"`, and `"format"`), never a second
grammar. Precedence is explicit flag > `GH_DELTA_<FLAG>` environment value >
project config > user config > current default. With neither config nor relevant
environment value, argv and output remain byte-identical to the legacy path.
`GH_DELTA_FORMAT=text` is supported; the unconditional default remains `json`,
including when stdout is a TTY.

`gh-delta doctor` is read-only and emits one row each for gh installation,
safe `gh auth status --active --hostname <host> --json hosts` authentication,
whether `read:org` is needed, GraphQL quota/reset, state-directory writability,
Node >=22, registry collisions, and temporary-state risk. Exit 0 means required
checks pass; exit 1 means one failed. `gh-delta explain <id>` requires exactly
one explicit `--log-file` or `--report-file`, applies `diffFingerprint` locally,
and never creates hidden last-report state or contacts GitHub. `gh-delta demo`
only prints the fixed public `diegomarino/gh-delta-demo` command.

`--version` prints the package version, distribution channel (`npm`, `gh
extension`, or `brew`), and the GitHub Releases URL. The root `gh-delta` shim
sets the `gh extension` channel; a Homebrew formula can set `GH_DELTA_CHANNEL=brew`.
