# Help Completeness

[Documentation](../README.md) · [Contract reference](../contract.md)

**`--help` and `--help-json` never list a flag or subcommand that is not
implemented.** One appears there in the same change that makes it work, never
earlier as a placeholder. The machine-readable help is what an agent reads as
this tool's contract, so a documented flag that always exits `2` is worse than
an undocumented one: it turns a discoverable capability into a dead end.

The converse holds too — a flag the parser accepts is always documented. Both
directions are enforced per command by a test that compares each subcommand's
parser option table against its help specification, so the two cannot drift.

The same reasoning applies to `DELTA_CLASSES`, `ERROR_KINDS`, and the other
catalogs exported from `gh-delta/contract`: they list what the detector can
actually emit today. A consumer validating against them is correct to reject
anything absent, and adding a name to a catalog before the code emits it would
break that guarantee.
