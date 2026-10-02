# Per-delta template examples

These examples use `--format template` on detector ticks and cursor reads. The [contract](contract/templates.md#per-delta-templates) defines the grammar and compatibility rules. Run the [local detector/read demo](https://github.com/diegomarino/gh-delta/blob/main/examples/per-delta-template/README.md) without contacting GitHub.

## Choose the source

| Need                                                          | Option                                                |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Short, one-off message                                        | `--template '<text>'`                                 |
| Reusable, versioned message                                   | `--template-file <local-path>`                        |
| Detect changes to an approved file                            | File source plus literal `--template-sha256 <digest>` |
| Construct another JSON object, group PRs or classify blockers | Keep the transformation in the consumer               |

Use exactly one source with `--format template`. File and inline sources use the same interpolation language. Shell examples use single quotes so braces and dollar signs are passed literally; gh-delta never evaluates shell code inside a template. File templates may end with one LF or CRLF, which is removed before parsing. They remain single-line templates.

### Example data and output notation

Examples 1–6 use the following **delta fragment**. It is not a complete detector report or an importable log record. IDs, fingerprints and unrelated fields are omitted to keep the presentation examples readable.

```json
{
  "repo": "acme/widgets",
  "entity": "pr",
  "number": 42,
  "classes": ["became-conflicting", "head-changed"],
  "seq": 17,
  "context": { "title": "Update widget" },
  "summary": {
    "state": "open",
    "ciRollup": "none",
    "reviewDecision": "review_required",
    "mergeable": "conflicting",
    "isDraft": false,
    "unresolvedReviewThreads": 0
  },
  "watch": {
    "labels": {
      "package": "F001-P05",
      "task.id": "t-0004",
      "thread": "t-0004"
    }
  }
}
```

Each shown output line ends with one LF. Unless stated otherwise, stderr is empty and a tick/read emitting the example delta exits **10**. Commands need a real observation or prepared log yielding the example fields; pasting a command does not guarantee a live repository changes. A first detector run normally establishes a quiet baseline.

Read the page for your task. The links below also preserve earlier section bookmarks.

| Topic                                                                                                                            | Reference                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| <a id="1-replace-the-short-jq-relay"></a>1. Replace the short jq relay                                                           | [Read](guides/templates/presentation.md#1-replace-the-short-jq-relay)                              |
| <a id="2-include-local-routing-labels"></a>2. Include local routing labels                                                       | [Read](guides/templates/presentation.md#2-include-local-routing-labels)                            |
| <a id="3-present-the-observed-state-without-a-readiness-decision"></a>3. Present the observed state without a readiness decision | [Read](guides/templates/presentation.md#3-present-the-observed-state-without-a-readiness-decision) |
| <a id="4-store-the-same-template-in-a-file"></a>4. Store the same template in a file                                             | [Read](guides/templates/files-and-verification.md#4-store-the-same-template-in-a-file)             |
| <a id="5-pin-reviewed-file-bytes-with-sha-256"></a>5. Pin reviewed file bytes with SHA-256                                       | [Read](guides/templates/files-and-verification.md#5-pin-reviewed-file-bytes-with-sha-256)          |
| <a id="6-replay-stored-deltas-using-a-cursor"></a>6. Replay stored deltas using a cursor                                         | [Read](guides/templates/replay-and-errors.md#6-replay-stored-deltas-using-a-cursor)                |
| <a id="7-optional-fields-missing-observations-and-escaping"></a>7. Optional fields, missing observations and escaping            | [Read](guides/templates/replay-and-errors.md#7-optional-fields-missing-observations-and-escaping)  |
| <a id="8-choose-fields-for-coordinator-routines"></a>8. Choose fields for coordinator routines                                   | [Read](guides/templates/replay-and-errors.md#8-choose-fields-for-coordinator-routines)             |
| <a id="9-preserve-exit-codes-in-a-wrapper"></a>9. Preserve exit codes in a wrapper                                               | [Read](guides/templates/replay-and-errors.md#9-preserve-exit-codes-in-a-wrapper)                   |
| <a id="10-deliberate-error-cases"></a>10. Deliberate error cases                                                                 | [Read](guides/templates/replay-and-errors.md#10-deliberate-error-cases)                            |
