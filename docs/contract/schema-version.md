# schemaVersion policy

[Documentation](../README.md) · [Contract reference](../contract.md)

`schemaVersion` is bumped **only** on a breaking change — a field renamed or
removed. **Additive changes** (new optional fields on the report, a delta, or a
fingerprint; new classes; new error kinds) **never bump `schemaVersion`.**
Unknown classes or kinds mean "something changed, inspect", never an error.
Assert `schemaVersion === 2` and handle unknown classes/kinds gracefully.

A schema-v1 snapshot or durable log is never migrated to v2 in place: it is a
permanent error hinting at `gh-delta reset` (see the [schema-v1 recovery note](../contract.md) and [`gh-delta reset`](reset.md#gh-delta-reset)).
