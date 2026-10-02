# Retire or clean one scenario safely

[Skill](../../SKILL.md) · [Choose an operating pattern](../patterns.md)

Before using this procedure, read [scenario ownership and repository discovery](ownership.md) for the variables and identity used below.

Stop work at its actual owner before moving state: interrupt and wait for a
foreground shell loop or `gh-delta wait`; disable the exact named scheduler job
for cron, launchd, or systemd; or use the stop handle returned by another
launcher. Do not discover a process by a broad `grep` and kill it by prefix. If
the launcher cannot be identified confidently, leave the scenario in place and
ask the user.

Then confirm that the exact root matches the requested agent type, eight
character session tag, and purpose, and inspect the owned state:

```bash
printf 'Retiring scenario: %s\n' "$SCENARIO_ROOT"
gh-delta list --state-dir "$STATE_DIR" --format text
find "$SCENARIO_ROOT" -maxdepth 2 -type f -print
```

Prefer a recoverable retirement over deletion:

```bash
ARCHIVE=".gh-delta/retired/$(basename "$SCENARIO_ROOT")-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$ARCHIVE")"
mv "$SCENARIO_ROOT" "$ARCHIVE"
printf 'Archived at: %s\n' "$ARCHIVE"
```

The global monitor registry can retain a `stale` breadcrumb after state is
moved; that is diagnostic history, not a live monitor. Delete an exact archived
root only when the user explicitly requests permanent removal and after a
readback. Never clean with a broad agent-prefix glob.
