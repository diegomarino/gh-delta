# Private Playground E2E

`gh-delta` needs one live acceptance test that proves GitHub mutations become
local detector activations. The playground e2e uses a private repository owned
by the authenticated `gh` user and validates the full loop:

1. prepare a private GitHub repository;
2. seed a local `gh-delta` baseline;
3. mutate GitHub state through `gh`;
4. run `gh-delta` again;
5. fail if the expected exit code or delta class is missing.

By default the harness creates a fresh private repository named
`gh-delta-test-playground-<run-id>` and deletes it in a `finally` block after the
run. Every run uses unique issue titles, branch names, labels, commit messages,
and local state under `/private/tmp/gh-delta-playground-e2e/<run-id>`.

## Scope

The first e2e cycle covers user-visible detector classes that are cheap to
generate with `gh`:

- `new` issue;
- `new-comments` issue;
- `relabeled` issue;
- `new` pull request;
- `new-comments` pull request;
- `merged` pull request.

It intentionally does not cover CI state, review decisions, or unresolved review
threads yet. Those need collaborators, branch protection, check runs, or review
APIs and should be added only after the basic live cycle is stable.

## Harness Contract

The harness should be runnable as:

```bash
npm run e2e:playground
```

Optional environment variables:

- `GH_DELTA_PLAYGROUND_REPO`: `owner/name` or plain repo name. Plain names use
  the authenticated `gh` user as owner. Explicit repositories are not deleted by
  default.
- `GH_DELTA_PLAYGROUND_KEEP_REPO=1`: keep a harness-created repository for
  inspection instead of deleting it at the end.
- `GH_DELTA_PLAYGROUND_STATE_DIR`: override local snapshot storage.

The command should print one compact line per step and exit non-zero on the
first failed expectation. A passing run proves the current checkout can observe
real GitHub issue and PR mutations through the public CLI path.

## Implementation Plan

1. Add unit tests for small pure helpers used by the harness:
   - repo spec parsing;
   - expected delta assertion;
   - run id safe-name generation.
2. Add `test/e2e/playground-e2e.mjs`:
   - shell out through `execFileSync`;
   - create a private repository with `gh repo create`;
   - clone the repository into `/private/tmp`;
   - commit and push a base README if needed;
   - run `node ./gh-delta.mjs` for each detector pass;
   - create issues, comments, labels, branches, commits, PRs, and merge PRs via
     `gh` plus `git`;
   - delete the harness-created repository with `gh repo delete <repo> --yes`.
3. Add `npm run e2e:playground`.
4. Verify locally with `npm test`, `npm run release:check`, and one live
   `npm run e2e:playground` execution outside the sandbox.
