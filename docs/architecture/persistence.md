# Snapshot Persistence

[Documentation](../README.md) · [Architecture by responsibility](../architecture.md)

`snapshot.mjs` owns the local memory boundary. It reads the previous snapshot,
provides the horizon used by incremental fetches, validates the next snapshot,
and writes atomically beside the target before renaming into place.

Missing snapshots are treated as first runs. Invalid snapshots are permanent
configuration problems, because silently replacing corrupt memory would erase the
watcher's history.

Do not run overlapping ticks against the same state file; use scheduler-level
locking if overlap is possible. Atomic writes prevent partial JSON snapshots,
but they do not make two concurrent detector passes a serialized workflow.

Without `--log`, successful detections remain snapshot-at-most-once: the snapshot
advances before an agent acts on deltas and before optional outpost delivery.
With opt-in `--log`, the same existing snapshot lock serializes `append + fsync +
manifest publication` before snapshot publication. The manifest binds the
reader-visible NDJSON prefix, so bytes written before fsync/publication are not
observable by consumers. A crash after a durable append but before snapshot still
creates an at-least-once replay seam: a content-addressed delta id can recur at a
later sequence. Consumer cursors are a local at-most-once convenience, not
acknowledgement; consumers deduplicate work by `id` when they need at-least-once
action delivery.

Consumer mutation is separately scoped: `read --advance` and `cursor set` hold
one `<cursor>.lock` through cursor read, log scan, and replacement. That prevents
same-cursor duplicate delivery and cursor rewind while retaining parallel,
lock-free non-advancing reads and independent cursor files.

Manifest publication also fsyncs its parent directory after atomic rename on
POSIX; Windows uses a writable non-truncating fsync of the final renamed manifest
because Node core cannot portably open a writable directory handle. A failed
durability sync is surfaced as an I/O failure without removing the renamed
manifest, so retry can recover from either durable state.

The initial manifest publishes an empty byte-zero prefix before the first record
write. Legacy readers reconcile a manifest appearing during their read, and all
record boundaries are raw strict-UTF-8 bytes so an invalid byte cannot alter a
published offset through replacement-character decoding.

Snapshot JSON shape and field semantics are specified in
[Snapshot Semantics](../contract/snapshots.md#snapshot-semantics).
