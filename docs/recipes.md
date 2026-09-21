# Agent recipes

Each recipe is a detector decision, not GitHub-mutation authorization. Read the
matching compact delta, make the stated decision, and use your own approval
boundary for writes.

| Situation              | Command                                                                                           | Response to exit `10`                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| PR merged              | `gh-delta --repo o/r --state-dir .state --format compact`                                         | Verify the merge, then propose deleting its branch and advancing dependent work.                               |
| Review requested       | `gh-delta --repo o/r --summaries --format compact`                                                | Notify the requested reviewer with the PR URL and current CI state.                                            |
| CI changed             | `gh-delta wait --repo o/r --state-dir .state --timeout 30m --until-summary ciRollup=green,failed` | On green, inspect review/mergeability; on failed, send the failing check to the worker.                        |
| CI red three times     | `gh-delta read --cursor .state/ci.cursor --only-classes ci-changed --advance`                     | Count repeated failed summaries in your durable worker state; escalate with links instead of retrying blindly. |
| Head changed in review | `gh-delta --repo o/r --detail --format compact`                                                   | Treat prior CI and approvals as stale; request a fresh review after inspecting the new head.                   |
| Stale for 48 h         | `gh-delta --repo o/r --stale-after 48h --format compact`                                          | Ping the current reviewer once for that stale period; do not emit a repeated nag every tick.                   |
| Changes requested      | `gh-delta --repo o/r --summaries --format compact`                                                | Relay the requested changes to the worker; hold merge action.                                                  |
| Unresolved threads     | `gh-delta --repo o/r --detail --format compact`                                                   | Read the named thread detail, then ask the owner to resolve or explain it.                                     |
| Item disappeared       | `gh-delta --repo o/r --format compact`                                                            | For `missing`, check scope and permissions; only treat `presumed-deleted` as gone.                             |
| Share one fetch        | `gh-delta --repo o/r --state-dir .state --log --format compact`                                   | Let workers use separate `read --cursor` files; each cursor advances only after its own action.                |

Exit `0` is baseline/no matching change (or wait timeout/signal); exit `1` is
retryable; exit `2` requires local configuration or snapshot repair. The exact
classes and report fields are in the [contract](contract.md).
