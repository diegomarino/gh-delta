# Template files and verification

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

### 4. Store the same template in a file

Create the 58-byte example file, including its final LF:

```sh
mkdir -p ./templates
printf '%s\n' 'thread={watch.labels.thread} {repo} #{number} [{classes}]' \
  > ./templates/coordinator.txt
```

Then use it:

```sh
gh-delta --repo acme/widgets --monitor-id example-relay \
  --state-dir ./state --watch-dir ./watch --entities pr --format template \
  --template-file ./templates/coordinator.txt
```

Expected stdout:

```text
thread=t-0004 acme/widgets #42 [became-conflicting,head-changed]
```

Passing the same content with inline `--template` produces the same bytes. Paths are relative to the process working directory, even when supplied through config. Prefer absolute paths in scheduled routines. Reading is done once per invocation; an edit after that accepted read only affects a later invocation.

### 5. Pin reviewed file bytes with SHA-256

The exact file from example 4 has this digest, **including the final LF**:

```text
eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba
```

Add that literal value to the reviewed command:

```sh
gh-delta --repo acme/widgets --monitor-id example-relay \
  --state-dir ./state --watch-dir ./watch --entities pr --format template \
  --template-file ./templates/coordinator.txt \
  --template-sha256 eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba
```

Expected output is unchanged from example 4. If any byte changes, the next run exits **2**, stdout is empty, stderr explains the mismatch, and no GitHub request or snapshot/log/cursor advancement occurs. LF-to-CRLF conversion and removal of the final LF also change the digest, even though file normalization could otherwise produce the same message.

For a real routine, review the template, calculate its digest once during preparation, put the digest literally in the command, and approve that command through the scheduler's human process. For subsequent edits, review the new content and approve the new command digest. Keep the executable/script pinned as well.

Do not calculate and substitute a fresh hash from the mutable template inside each scheduled command. That would approve whatever bytes happened to be present. Keeping an editable `.sha256` file next to an editable template has the same limitation if both can be changed by the same actor.
