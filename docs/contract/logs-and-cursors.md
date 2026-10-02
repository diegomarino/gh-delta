# Delta Log and Cursors

[Documentation](../README.md) · [Contract reference](../contract.md)

With `--log`, the producer holds its existing snapshot lock through this order:
`detect -> ids/attention filter -> assert lock -> append + fsync log -> atomic
manifest publish -> assert lock -> atomic snapshot -> transient enrichment ->
registry/report/outpost`.
Append failure is
`kind: "io"` / exit `1` (or `kind: "log"` / exit `2` for invalid committed log
content), and leaves the snapshot unchanged. A crash after a durable append but
before snapshot publication may append the same content-addressed `delta.id` at a
later `seq` on retry. This is intentionally at-least-once journal delivery;
consumers deduplicate work by `id`.

Each complete UTF-8 NDJSON line has exactly `seq`, `id`, `detectedAt`, `delta`,
`repo`, and `monitorId` (see `DELTA_LOG_RECORD_FIELDS` in `gh-delta/contract`
— `repo`/`monitorId` let a reader identify which producer wrote a record
without re-deriving it from the log's own filename); `seq` starts at 1 and is
strictly contiguous, and `id === delta.id`. The journal stores the exact
pre-enrichment delta after attention filters and requested durable decoration;
transient `--enrich` bodies are never logged. When the captured watch entry had
labels, the logged delta includes the same optional `watch.labels` map as the
report. Cursor reads replay that recorded map. `<logFile>.published.json` is the
small publication manifest. Manifest v3 — exactly
`{"version":3,"firstSeq":F,"lastSeq":N,"byteLength":B,"dataFile":"<same-directory filename>"}`
— is the only supported generation; there is no reader for the older v1
(`{"version":1,"lastSeq":N,"byteLength":B}`, implicit `dataFile === logFile`)
or v2 (adds `firstSeq`, still implicit `dataFile`) manifests, and no
migration. A log whose bytes exist without a readable v3 manifest — an older
manifest, or a legacy pre-manifest raw-NDJSON log — is rejected with a `log`
error naming `gh-delta reset` as the documented recovery; there is no
bootstrap path any more. Readers fully validate every line in the selected
prefix and ignore suffix bytes even when they end in a newline. A cursor or
`afterSeq` above `lastSeq` is a permanent `log` error rather than an empty
replay — this is also the mechanism behind
[the reset-then-stale-cursor case](reset.md#gh-delta-reset): a reset log's fresh
`lastSeq: 0` makes any pre-reset cursor seq immediately "above the tail".

`gh-delta log compact --keep <positive-count|duration>` is the only retention
operation. It requires one producer state location and takes that state-file
lock through a fenced, same-directory generation publication. Compacted
version-3 manifests add a fresh `firstSeq` and a new same-directory `dataFile`
generation, preserving original sequence numbers. The immutable generation is fsynced before the manifest
atomically selects it, so lock-free readers resolve to either the old or new
complete publication; a reader racing best-effort cleanup retries against the
current manifest. A failure after the manifest rename leaves that selected
generation intact and readable. Empty retention stores `firstSeq: lastSeq + 1`,
so a later append uses `lastSeq + 1`. A cursor behind the retained prefix
receives retained records and one
`{label:"retention",reason:"cursor behind retention"}` warning; a cursor at
`firstSeq - 1` is safe, and a cursor above `lastSeq` remains a `log` error.

Publication fsyncs the log, then a same-directory manifest temp file, atomically
renames that temp file, and fsyncs the manifest parent directory before append
returns or a snapshot may publish. A directory open/fsync failure is an I/O
failure: the renamed manifest remains for safe recovery and the snapshot stays
unchanged. POSIX uses a non-mutating read handle; Windows uses a non-truncating
writable handle on the final renamed manifest as the Node-core-supported
`FlushFileBuffers` fallback.

For a brand-new log, the first append first publishes the empty
`{version:3,firstSeq:1,lastSeq:0,byteLength:0,dataFile:<basename(logFile)>}`
boundary; that boundary is valid even if the log file does not yet exist, so a
failed first-record fsync remains invisible to readers.
For ordinary manifest-backed appends, the committed prefix is trusted by the
writer and only the bounded unpublished suffix plus newly serialized records are
validated; reads always validate the whole published prefix. On recovery, a valid
contiguous complete suffix is fsynced and promoted, an unterminated suffix is
truncated, and a malformed complete suffix fails closed without mutation. A
manifest ahead of a missing/truncated log is a permanent `log` error.

`gh-delta reset` deletes both the manifest and data file for a monitor's log in
one lock-scoped operation (see [`gh-delta reset`](reset.md#gh-delta-reset)); a reset log
behaves exactly like a brand-new one on the next append.

Byte lengths are raw UTF-8 byte offsets, not decoded-string lengths. Invalid
UTF-8 in any complete published record or complete suffix is a permanent `log`
error before mutation. Recovery opens its non-truncating fsync handle writable
(`r+`) for Windows compatibility.

A cursor is atomically replaced JSON with exactly
`{"cursorVersion":1,"logFile":"/absolute/log.ndjson","seq":41}`. `seq` is a
non-negative safe integer (`0` means before the first record) and the absolute
`logFile` binds one consumer to one journal. Give independent consumers distinct
cursor files. `--advance` is an at-most-once convenience, not downstream
acknowledgement. `read --advance` and `cursor set` acquire the existing lock
protocol at `<cursor>.lock` before reading the cursor and hold it through scan
and atomic replacement; a concurrent mutator is `kind: "busy"` / exit `1` and
does not read, deliver, or write. The fixed local lease is 5 seconds plus the
lock slack and stale threshold is 30 seconds; it is renewed immediately before
replacement. Non-advancing reads remain lock-free, and distinct cursor files can
proceed independently. Explicit lower-sequence replay remains allowed under the
same lock. `setCursorAtomic` itself remains a low-level atomic replacement, not a
compare-and-swap primitive.

Read report fields, in order, are `schemaVersion`, `command`, `logFile`, `at`,
`cursor`, `deltas`, `summary`, and `warnings` (see `READ_REPORT_FIELDS` in
`gh-delta/contract`); cursor fields are `path`, `from`, `to`, and `advanced`.
Cursor-set report fields are `schemaVersion`, `command`, `at`, `repo`, `repos`,
`monitorId`, `cursor`, and `summary`; its cursor fields are `path`, `logFile`,
`from`, and `to`. `gh-delta log compact` report fields are `schemaVersion`,
`command`, `logFile`, `at`, `keep`, `previous`, `retained`, and `summary`
(`previous`/`retained` are `{firstSeq, lastSeq, count}` bounds).
