# Delta Summaries

[Documentation](../README.md) · [Operating procedures](../../RUNBOOK.md)

Every PR delta that has a current object (`from`/`to` observed) carries a
normalized, typed `summary` object unconditionally — no flag needed. It is
derived from the same single observation as the fingerprint — no second
GitHub call — and is a sibling of `to`, so the content-addressed `delta.id`
and every existing field are unaffected by its presence. `--summaries` is a
deprecated no-op kept only so old scripts that still pass it are unaffected.
Fields, enum domains, and honesty semantics (`ciRollup: none` for zero
checks, `mergeable: unknown` for not-yet-computed) are specified in
[Delta Summary schema](../contract/summary.md#delta-summary-schema).

Live acceptance check (proves the load-bearing `ciRollup` end to end against real
GitHub, using a scratch PR you own):

```bash
STATE=$(mktemp -d)
REPO=you/scratch          # a repo with NO required checks on the PR's base
PR=1                      # an open PR whose head has no commit status yet

# 1. Seed a baseline while the PR has zero checks.
gh-delta --repo "$REPO" --monitor-id acc --state-dir "$STATE" --entities pr

# 2. Post a successful commit status on the PR head and re-run.
HEAD=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)
gh api "repos/$REPO/statuses/$HEAD" -f state=success -f context=acceptance >/dev/null
gh-delta --repo "$REPO" --monitor-id acc --state-dir "$STATE" --entities pr \
  | jq '.deltas[] | select(.classes | index("ci-changed")) | .summary.ciRollup'
# expect: "green"   (and a fresh baseline against the zero-check PR reports "none")
```
