# Per-delta template examples

These examples use `--format template` on detector ticks and cursor reads. The [contract](contract.md#per-delta-templates) defines the grammar and compatibility rules. Run the [local detector/read demo](../examples/per-delta-template/README.md) without contacting GitHub.

### Choose the source

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

### 6. Replay stored deltas using a cursor

Given a cursor already pointing at a valid log whose next matching record has the example fields:

```sh
gh-delta read --cursor ./triage.cursor.json --format template \
  --template 'seq={seq} {watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}'
```

Expected stdout:

```text
seq=17 t-0004: acme/widgets #42 {state=open}
```

Double braces produce literal braces. Without `--advance`, the cursor is unchanged and the next read can return the same delta. Add `--advance` only when consuming the scanned log range is intended. Successful advancement records consumption before any downstream delivery; it does not acknowledge successful delivery.

Reads render stored labels, not today's watch directory. Old unlabeled records leave label slots empty. Reads accept `--template-file` and `--template-sha256` too, but do not inherit detector config or fetch enrichment.

### 7. Optional fields, missing observations and escaping

| Value in the selected delta          | Template                                       | Result before the final LF |
| ------------------------------------ | ---------------------------------------------- | -------------------------- |
| `summary: null` on a missing delta   | `PR #{number}: state={summary.state}`          | `PR #42: state=`           |
| Label `thread` absent                | `thread={watch.labels.thread}`                 | `thread=`                  |
| `summary.isDraft: false`             | `draft={summary.isDraft}`                      | `draft=false`              |
| `summary.unresolvedReviewThreads: 0` | `unresolved={summary.unresolvedReviewThreads}` | `unresolved=0`             |
| `to.labels: []`                      | `labels={to.labels}`                           | `labels=`                  |
| `to.labels: ["bug", "needs-review"]` | `labels={to.labels}`                           | `labels=bug,needs-review`  |

An unsupported path is different from absent optional data: `{summary.typo}` fails validation even on an empty tick. There are no fallback expressions such as `{summary.state ?? "unknown"}`.

For an explicitly selected title, suppose the JSON string value is `"Fix widget\n{summary.state}"`. The template `title={context.title}` produces one physical output line:

```text
title=Fix widget\n{summary.state}
```

The newline becomes the two visible characters `\n`; braces inside the value are not evaluated again. A backslash becomes `\\`, a tab becomes `\t`, and terminal escape/control characters become visible escapes. Ordinary prose inside an untrusted field remains ordinary prose, including malicious instructions; escaping does not make it trustworthy.

### 8. Choose fields for coordinator routines

For a short notification, prefer `repo`, `entity`, `number`, `classes`, controlled local watch labels, and normalized summary enums/counts. A template such as example 2 is enough to route a notice and trigger a fresh state check.

Avoid `context.title`, `context.headRefName`, `summaryLine`, body enrichment and other GitHub-authored strings in the routine message. They are available for deliberate presentation use, but may carry attacker-written instructions. A hash protects the template's literal text; it does **not** authenticate the values substituted into it.

Treat the entire resulting message as observation data. Routing policy, permitted actions and instructions must come from the coordinator's trusted configuration. Nothing in per-delta templates automatically enforces that coordinator policy or sanitizes natural-language intent. The consumer's 4,000-character cap can still truncate output, including messages with large repeated fields.

### 9. Preserve exit codes in a wrapper

A POSIX shell wrapper can capture the status without masking exit 10. This example creates no message delivery side effect:

```sh
if gh-delta --repo acme/widgets --monitor-id example-relay \
  --state-dir ./state --entities pr --format template \
  --template '{entity} #{number} [{classes}]'; then
  tick_status=0
else
  tick_status=$?
fi
exit "$tick_status"
```

| Situation                                          | stdout                                | stderr                           | Exit          |
| -------------------------------------------------- | ------------------------------------- | -------------------------------- | ------------- |
| Quiet baseline or tick, no warning                 | Zero bytes                            | Zero bytes                       | 0             |
| One or more emitted deltas                         | One line per delta                    | Empty unless warnings            | 10            |
| Transient failure                                  | Empty for a failed single-repo tick   | Error diagnostics                | 1             |
| Invalid template, unreadable file or hash mismatch | Zero bytes                            | Error diagnostic                 | 2             |
| Retention/enrichment warning                       | Normal selected lines, possibly empty | Warning diagnostic               | Existing 0/10 |
| Multi-repo partial failure                         | Successful repositories' lines remain | Failed repositories' diagnostics | 1 or 2        |

Two quiet ticks with no diagnostics have identical `(exit, stdout, stderr)`. An event-to-quiet transition changes that tuple once. Templates produce no `end` record; do not add `--omit-end`. If running atomic watch sync first, capture its success JSON separately and check its status before starting detection. Keep producer success checking outside a pipeline that could commit a partial desired set.

### 10. Deliberate error cases

All are configuration failures detected before detector/cursor effects:

| Input                                                                     | Reason                                 |
| ------------------------------------------------------------------------- | -------------------------------------- |
| Both `--template` and `--template-file` in the same selected source layer | Ambiguous source                       |
| `--template-sha256` with inline text                                      | Digest requires a file                 |
| Digest containing fewer than 64 hexadecimal digits                        | Invalid digest                         |
| `{summary.failedChecks}` or `{from.checks[0].name}`                       | Object arrays/indexing are unsupported |
| `{watch.labels.constructor}`                                              | Reserved key                           |
| A template containing two actual lines                                    | One-line grammar                       |
| `--template-file -`, a FIFO, directory, invalid UTF-8 or BOM              | Unsupported input                      |
| More than 4,096 normalized template bytes                                 | Input limit                            |
| `--format json --template '{number}'`                                     | Format/source mismatch                 |

For supported template-mode attempts, these errors use stderr and empty stdout. Incompatible formats/subcommands retain their ordinary error rendering; they still exit 2 before work. No example assumes that printed output means external delivery succeeded.
