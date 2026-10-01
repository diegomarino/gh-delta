# Per-delta template examples

Companion examples for `--format template` on detector ticks and `gh-delta
read`. The [contract](contract.md#per-delta-templates) is canonical. These
commands describe current behavior.

`{watch.labels.task.id}` looks up the single label key `task.id`. File
`--template-sha256` values are SHA-256 of the **raw file bytes**, including a
trailing newline later stripped for compilation. Escaping does not make
interpolated title or body text safe to execute. `read` does not inherit
detector template config. Output is not NDJSON and does not emit `end`.

## Detector and read

```sh
gh-delta --repo owner/repo --format template --template '{entity} #{number} [{classes}]'
```

```text
pr #42 [ci-changed,new-comments]
```

```sh
gh-delta read --cursor ./triage.cursor.json --advance --format template \
  --template '{watch.labels.task.id}: {repo} #{number} {{state={summary.state}}}'
```

With label `task.id=t-0004`:

```text
t-0004: owner/repo #42 {state=open}
```

Without that label the line still starts with `: owner/repo`. A quiet tick or
read exits `0` with empty stdout. `{summary.typo}` exits `2` before fetch or
cursor advancement.

## File pin

A 58-byte file that ends with one LF:

```sh
printf '%s\n' 'thread={watch.labels.thread} {repo} #{number} [{classes}]' \
  > ./templates/coordinator.txt
```

Raw-byte digest including the final LF:

```text
eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba
```

```sh
gh-delta --repo acme/widgets --format template \
  --template-file ./templates/coordinator.txt \
  --template-sha256 eb40f3aa760d766971912055a7fb34995cedcf7f4114725b989b0d5fe685e3ba
```

A mismatch exits `2` with empty stdout and does not fetch or advance state.

## Values

| Selected value                        | Template                                       | Line before the final LF             |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| `summary: null`                       | `PR #{number}: state={summary.state}`          | `PR #42: state=`                     |
| `summary.isDraft: false`              | `draft={summary.isDraft}`                      | `draft=false`                        |
| `summary.unresolvedReviewThreads: 0`  | `unresolved={summary.unresolvedReviewThreads}` | `unresolved=0`                       |
| `title: Fix widget\\n{summary.state}` | `title={context.title}`                        | `title=Fix widget\\n{summary.state}` |

A newline inside a substituted field becomes the two characters `\` and `n` on
one physical line. Braces inside values are not scanned again.
