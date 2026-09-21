# Decision boundaries

- Treat exit codes as the primary result. Only `0` or `10` are successful detector outcomes; `1` leaves snapshot state unchanged and can be retried, while `2` needs configuration or snapshot repair.
- A detector tick owns one snapshot. Use a stable `--monitor-id` for the same recurring watcher; independent consumers replay the append-only log through distinct cursors.
- `wait` is bounded worker polling. Give it a timeout and an explicit terminal condition. It does not authorize a GitHub mutation after the condition is met.
- `read --advance` commits a consumer cursor. Handle the records durably before advancing; otherwise leave it unadvanced for replay.
- `status` reads local state. Add `--refresh` only when a normal detector tick is needed first; it may contact GitHub and write the snapshot.

For field-level meanings and complete safety guarantees, consult the repository's
`docs/contract.md`; it is the canonical contract, not this skill.
