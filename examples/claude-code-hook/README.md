# Claude Code turn hook

Run one detector tick after a turn and add its report to context only for exit
`10`; no-change turns cost no context tokens.

```bash
set +e
report=$(gh-delta --repo diegomarino/gh-delta-demo --monitor-id claude-hook \
  --state-dir .gh-delta --entities pr --format compact)
code=$?
set -e
[ "$code" -eq 10 ] && printf '%s\n' "$report"   # hand this to the next turn
case "$code" in
  0) exit 0 ;;                                    # baseline/no change
  10) exit 0 ;;                                   # report emitted; hook succeeds
  1) echo "gh-delta retryable error" >&2; exit 0 ;;
  2) echo "gh-delta configuration/snapshot error" >&2; exit 2 ;;
  *) echo "unexpected gh-delta exit $code" >&2; exit 1 ;;
esac
```

The hook observes only; the turn decides any GitHub mutation. Its exit contract
is: detector `0` → hook `0`, `10` → print report then hook `0`, `1` → hook `0`
for the next turn to retry, `2` → hook `2`, unknown → hook `1`. `run.sh` proves
the exit-10 branch with a local injected observation.
