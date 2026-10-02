# Per-delta templates

[Documentation](../README.md) · [Contract reference](../contract.md)

`--format template` compiles a one-line grammar before repository resolution,
fetches, locks, log appends, snapshot writes, or cursor advancement. Unknown
static paths (including `{summary.typo}`) exit `2` with empty stdout even on a
quiet tick or empty log. Diagnostics use `gh-delta: error <canonical JSON>`
and `gh-delta: warning <canonical JSON>` on stderr.

The complete initial placeholder allowlist is:

| Paths                                                                                                                                                                                             | Values                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `id`, `repo`, `entity`, `number`, `missingTicks`, `firstObserved`, `seq`, `summaryLine`, `staleAt`                                                                                                | Scalar                   |
| `classes`                                                                                                                                                                                         | Primitive array          |
| `context.id`, `context.title`, `context.url`, `context.author`, `context.createdAt`, `context.headRefName`                                                                                        | Scalar                   |
| `summary.ciRollup`, `summary.reviewDecision`, `summary.mergeable`, `summary.mergeStateStatus`, `summary.state`, `summary.isDraft`, `summary.unresolvedReviewThreads`, `summary.headSha`           | Scalar                   |
| Each of `from` and `to`, followed by `.state`, `.updatedAt`, `.isDraft`, `.headSha`, `.baseRef`, `.mergeable`, `.mergeStateStatus`, `.reviewDecision`, `.conversationComments`, `.reviewComments` | Scalar                   |
| Each of `from` and `to`, followed by `.labels`, `.assignees`, `.reviewRequests`                                                                                                                   | Primitive array          |
| `enrichment.body.body`, `enrichment.body.mentions`                                                                                                                                                | Scalar / primitive array |
| `watch.labels.<key>`                                                                                                                                                                              | Optional label string    |

For `watch.labels.<key>`, the entire suffix is one own-property key, including
literal dots. Keys match `[A-Za-z][A-Za-z0-9_.-]{0,31}`; `until`, `repo`,
`__proto__`, `constructor`, and `prototype` are reserved. Missing labels are
valid and render empty. Object parents, object arrays, indexing, wildcards,
expressions, defaults, environment lookup, and recursive interpolation are
unsupported. Absent/null values render empty, while `0` and `false` retain
their spelling. Primitive arrays preserve order and join escaped elements
with commas; null elements are empty. Unexpected objects at allowed leaves
exit `2`.

Scan left to right: `{{` emits `{`, `}}` emits `}`, and `{path}` substitutes a
listed path. Reject unmatched/nested braces, empty placeholders, whitespace
inside placeholders, and unknown paths even without deltas. Backslashes are
literal. Templates must be nonempty and at most 4,096 UTF-8 bytes; literal
C0/C1 controls, DEL, U+2028, U+2029, tabs, and newlines are rejected. Values
escape backslash, LF, CR, TAB, and other controls as specified by the [CLI format contract](cli.md#cli); quotes
and braces remain literal. The input limit does not cap rendered output.

File sources accept only local regular files (including symlinks resolving to
regular files), never stdin, URLs, devices, directories, or FIFOs. Open
nonblocking and verify the opened descriptor before reading at most 4,099
bytes to enforce a 4,098-byte raw limit. Decode UTF-8 without BOM, strip at
most one final LF/CRLF, then apply the 4,096-byte grammar limit. Hash the same
accepted raw bytes before decoding/stripping; read once per invocation and
reuse the compiled template for every repository and delta. Missing/unreadable
files, bad encoding, and malformed/mismatched digests exit `2` before effects.

Repeated, missing, empty, or conflicting source options are configuration
errors. The winning source layer is selected as one group; an empty source
cannot fall back to a lower layer. Template config keys require strings.
Explicitly recognizable template detector/read requests emit configuration
errors on stderr with empty stdout. Malformed configuration cannot establish
a trusted format; config-loader failures honor only explicit template format.
Unsupported commands and incompatible formats retain ordinary error rendering.

Render original emitted deltas in detector/log order with exactly one LF per
line, even if every substitution is empty. Print no filtered deltas, footer,
or summary; zero deltas means zero stdout bytes. Preserve exit codes `0`, `10`,
`1`, and `2`, and successful repository lines on aggregate partial failure.
Durable values are checked before each repository publishes; selected read
rows are checked before cursor advancement. Transient enrichment is checked
after its existing fetch stage and cannot roll back already published data.
Read templates obtain `repo` and `seq` from journal metadata without changing
public delta/report objects, never regenerate summaries or fetch enrichment,
and preserve scanned-tail advancement semantics.

`--full` is a detector no-op for templates; fingerprint leaves remain
available. `--summary-line` and `--detail` retain generation semantics, and
only explicit `{summaryLine}` prints that field. Selecting enrichment fields
never enables fetching. Errors precede warnings; diagnostic JSON recursively
sorts keys and escapes controls/separators. Mirrored warnings use the maximum
occurrence count across containers, preserving encounter order; add no
heartbeat/timestamp and do not change status for warnings. Template mode uses
the same diagnostic renderer as NDJSON `--omit-end`.

Worked examples and scheduler trust boundaries:
[template examples](../template-examples.md).
