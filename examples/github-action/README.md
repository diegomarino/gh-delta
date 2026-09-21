# GitHub Action integration shape

An official reusable action belongs in the separate `gh-delta-action` repository.
Until that external publication exists, use the local workflow example in
[`../github-actions-slack-digest`](../github-actions-slack-digest/) or call the
CLI directly. This complete local workflow shape restores and saves durable
state, publishes `changed` and JSON `report` outputs, and keeps all exit paths
explicit:

```yaml
jobs:
  tick:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    concurrency:
      group: gh-delta-${{ github.repository }}
      cancel-in-progress: false
    outputs:
      changed: ${{ steps.tick.outputs.changed }}
      report: ${{ steps.tick.outputs.report }}
    steps:
      - uses: actions/cache/restore@v4
        with:
          path: .gh-delta-state
          key: gh-delta-state-${{ github.run_id }}
          restore-keys: gh-delta-state-
      - id: tick
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set +e
          npx gh-delta --repo "$GITHUB_REPOSITORY" --monitor-id actions-cache \
            --state-dir .gh-delta-state --format compact > report.json
          code=$?
          set -e
          [ "$code" -eq 10 ] && changed=true || changed=false
          echo "changed=$changed" >> "$GITHUB_OUTPUT"
          echo "code=$code" >> "$GITHUB_OUTPUT"
          { echo 'report<<GH_DELTA_REPORT'; cat report.json; echo GH_DELTA_REPORT; } >> "$GITHUB_OUTPUT"
          case "$code" in
            0|10) exit 0 ;;
            1) echo "::warning::gh-delta retryable error"; exit 0 ;;
            2) echo "::error::gh-delta configuration or snapshot error"; exit 2 ;;
            *) echo "::error::unexpected gh-delta exit $code"; exit 1 ;;
          esac
      - if: ${{ always() && steps.tick.outputs.code != '2' }}
        uses: actions/cache/save@v4
        with:
          path: .gh-delta-state
          key: gh-delta-state-${{ github.run_id }}
```

Cache the state directory and make downstream jobs consume `changed` plus the
JSON report. `run.sh` locally exercises a changed compact detector report with
an injected demo observation; it does not run Actions or mutate GitHub.
