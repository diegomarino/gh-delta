# First Baseline and Repeated Runs

[Documentation](../README.md) · [Usage by task](../usage.md)

## Initialize a durable project monitor

Inside a checkout, the shortest safe setup is:

```bash
gh-delta init
gh-delta
```

`init` first establishes the same baseline as a normal tick, then writes a
non-overwriting `.gh-delta.json`. Later detector ticks can be `gh-delta` with no
flags. For agent scheduler snippets without installing anything, add `--agent`;
the emitted cron and systemd snippets include the resolved repo, monitor,
entities, durable state directory, and working directory, so they can run from
outside the checkout.
Use `gh-delta doctor` for read-only prerequisite diagnosis, and keep JSON as the
agent-safe default (set `GH_DELTA_FORMAT=text` only for an operator profile).

The first successful run seeds a local snapshot and exits `0`:

```bash
gh-delta --repo owner/repo --monitor-id prs-5m --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --entities pr
```

Later runs with the same repo, monitor id, state location, and entity set compare
GitHub state against that snapshot. A durable monitor should pass `--state-dir`
or `--state-file` explicitly; the zero-config temp-dir default is useful for
ad-hoc checks but can re-baseline after reboot or tmp cleanup.

For scheduled logs, prefer text output:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr \
  --format text
```

For programs and agents, prefer JSON output:

```bash
gh-delta \
  --repo owner/repo \
  --monitor-id prs-5m \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" \
  --entities pr \
  --format json \
  --detail
```

`wait` is JSON-only because callers need `reason` and `iterations`. For a one-line
relay of each emitted delta, use `--format template` with exactly one of
`--template` or `--template-file`. This is not NDJSON and does not emit `end`.
The placeholder allowlist lives in the
[contract](../contract/templates.md#per-delta-templates). `{watch.labels.task.id}` is one
label key. `--template-sha256` hashes the raw file bytes. Escaping does not make
title or body text safe to execute. `read` does not inherit detector template
config. Worked examples: [template examples](../template-examples.md).

```bash
gh-delta --repo owner/repo --format template --template '{entity} #{number} [{classes}]'
```

```bash
gh-delta read --cursor ./triage.cursor.json --advance --format template \
  --template '{watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}'
```
