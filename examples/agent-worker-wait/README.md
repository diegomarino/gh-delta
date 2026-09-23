# Agent worker: wait for CI

The worker owns one PR and waits for a bounded, semantic condition. Production
command:

```bash
PR_NUMBER=42 # required: the PR this worker owns
gh-delta wait --repo diegomarino/gh-delta-demo --monitor-id worker-42 \
  --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --entities pr --timeout 30m \
  --number "$PR_NUMBER" \
  --until-summary ciRollup=green,failed
```

Exit `10` means `reason` is `until` or `already-satisfied`; inspect the PR and
choose the next action. Exit `0` means timeout/signal; exit `1` retries later;
exit `2` needs a configuration repair. `run.sh` is a deterministic local smoke:
it injects a green demo observation and never calls GitHub.

## Claude Code / opencode prompt

```text
Set PR_NUMBER to the PR this worker owns, then run the command above exactly
once. Read JSON only when it exits 10. Inspect that matching PR's reviews and
CI, then report the next proposed action. Keep the PR unchanged unless the
human has separately authorized a mutation.
```
