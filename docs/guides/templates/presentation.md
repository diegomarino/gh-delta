# Template presentation and routing

[Documentation](../../README.md) · [Template examples by task](../../template-examples.md)

These examples use `--format template` on detector ticks and cursor reads. The [contract](../../contract/templates.md#per-delta-templates) defines the grammar and compatibility rules. Run the [local detector/read demo](https://github.com/diegomarino/gh-delta/blob/main/examples/per-delta-template/README.md) without contacting GitHub.

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

### 1. Replace the short jq relay

```sh
gh-delta --repo acme/widgets --monitor-id example-relay \
  --state-dir ./state --entities pr --format template \
  --template '{entity} #{number} [{classes}]'
```

Expected stdout:

```text
pr #42 [became-conflicting,head-changed]
```

This prints the existing class list in order; it does not classify readiness or invent a message type. It includes no title, body or branch text.

### 2. Include local routing labels

```sh
gh-delta --repo acme/widgets --monitor-id example-relay \
  --state-dir ./state --watch-dir ./watch --entities pr --format template \
  --template 'thread={watch.labels.thread} package={watch.labels.package}: {repo} #{number} [{classes}]'
```

Expected stdout:

```text
thread=t-0004 package=F001-P05: acme/widgets #42 [became-conflicting,head-changed]
```

This needs watch labels on the watched PR. Without labels, the fields are empty and surrounding literal text remains:

```text
thread= package=: acme/widgets #42 [became-conflicting,head-changed]
```

Labels are local routing context, not proof of authority. Keep the mapping from repository/PR to authorized work in the consumer. A literal dot in a label key is supported: `{watch.labels.task.id}` reads the single key `task.id` and produces `t-0004`.

### 3. Present the observed state without a readiness decision

Template:

```text
PR #{number}: CI={summary.ciRollup}; review={summary.reviewDecision}; mergeable={summary.mergeable}; unresolved={summary.unresolvedReviewThreads}; draft={summary.isDraft}
```

Expected stdout:

```text
PR #42: CI=none; review=review_required; mergeable=conflicting; unresolved=0; draft=false
```

Zero and false are preserved. `CI=none` means no checks, not successful checks. The template reports observations; the consumer decides what requires action after checking authoritative current state.
