# Programmatic Use

[Documentation](../README.md) · [Usage by task](../usage.md)

Use explicit ESM subpaths. The package root is intentionally not exported.

```js
import { detectDeltas } from 'gh-delta/detect';
import { buildOutpostPayload } from 'gh-delta/outpost';
import { REPORT_SCHEMA_VERSION } from 'gh-delta/contract';
```

Use the binary for CLI execution and subpaths for embedding pieces in an
orchestrator. The full import table lives in
[Programmatic API Surface](../contract/programmatic-api.md#programmatic-api-surface).

This release ships plain ESM `.mjs` files and no bundled TypeScript declaration
files. TypeScript consumers should pin to a known `gh-delta` version and add
local types if they need compile-time checking.
