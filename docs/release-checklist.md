# Release Checklist

Use this checklist before publishing `gh-delta` to npm.

## Release Process

This is the end-to-end flow that ships a release, from commit to npm:

1. **Conventional Commits land on `main`.** Every merged PR's commits follow the
   [Conventional Commits](../CONTRIBUTING.md#commit-convention) format
   (`feat:`, `fix:`, etc.). release-please reads these to decide the next
   version and changelog section; a non-conforming message is invisible to
   the pipeline.
2. **release-please opens or updates a release PR.** On every push to `main`,
   `.github/workflows/release-please.yml` runs
   [`googleapis/release-please-action`](https://github.com/googleapis/release-please-action),
   which maintains a standing "chore(main): release gh-delta X.Y.Z" PR. That
   PR's diff is entirely generated: it bumps the `version` field in
   `package.json` and prepends the new section to `CHANGELOG.md`. Never
   hand-edit either field/file directly — release-please owns both, and a
   manual edit will be overwritten or cause a merge conflict on the next run.
3. **Merging the release PR tags and creates a GitHub Release.**
   Merging that PR is the release trigger: release-please tags the commit
   (`vX.Y.Z`) and publishes a GitHub Release for it.
4. **The GitHub Release publishes to npm.** `.github/workflows/publish.yml`
   listens for `release: published`, checks out the released tag, and runs
   `npm publish --provenance --access public` using npm's OIDC Trusted
   Publisher flow — there is no long-lived `NODE_AUTH_TOKEN` secret; npm
   authenticates the workflow run directly via its GitHub Actions OIDC token.
   `--provenance` attaches a signed build provenance attestation to the
   published package, linking the npm artifact back to this exact workflow
   run and commit.
5. **Context7 refresh (best-effort).** The same `release: published` event
   also triggers `.github/workflows/context7-refresh.yml`, which pings
   Context7's refresh API so the docs published in this release become
   searchable there quickly. This step is non-fatal — it never blocks or
   fails the release if the ping fails.

Both `release-please.yml` and `publish.yml` are gated behind the
`vars.RELEASE_AUTOMATION_ENABLED` repository variable; when it is not
`'true'`, both jobs are no-ops.

The checklist below is what a maintainer runs locally, before merging the
release-please PR, to confirm the release it is about to cut is safe to ship.

## Local Gate

Run:

```bash
npm ci --cache .npm-cache
npm run release:check
node ./gh-delta.mjs --help
node ./gh-delta.mjs --help-json
node ./gh-delta.mjs --version
```

Expected:

- lint passes;
- Prettier reports every file as formatted;
- all Node tests pass;
- the coverage report completes;
- `npm pack --dry-run` lists only expected public package files;
- the CLI prints human help, JSON help, and version output, then exits `0`.

## Example Artifacts

The README screenshots and demo are generated from fixtures. If the report shape
(`lib/contract.mjs`) changed since the last release, regenerate them so they stay
truthful:

```bash
npm run examples:svg
```

`test/examples.test.mjs` fails when the fixtures drift from the frozen contract,
so a red `release:check` is the signal to regenerate. Commit any changed
`docs/img/*.svg`. Requires `jq` and network access for `npx svg-term-cli`.

## Publish Safety

Check for private or local-only material:

```bash
rg -n "(\\/Users\\/|~\\/|m[ar]planner|M[od]els|OPENAI[_]API[_]KEY|ANTHROPIC[_]API[_]KEY|GITHUB[_]TOKEN|npm_[A-Za-z0-9])" .
```

Expected:

- no personal filesystem paths;
- no private project names;
- no API keys, npm tokens, GitHub tokens, or auth headers;
- no generated state snapshots;
- no `.tgz`, coverage output, or `node_modules` in the package.

## Metadata

Before the first public publish:

- confirm the npm package name is available or choose a scoped package name;
- confirm `repository`, `bugs`, and `homepage` point at the real GitHub repo;
- verify the release-please PR's generated CHANGELOG section — never hand-edit `CHANGELOG.md`;
- tag the release after the publish commit.

## Package Contents

The package should contain exactly the files enumerated in `package.json#files`
(that array is the single source of truth — reconcile this list against it,
not the other way around):

- `gh-delta.mjs`;
- `lib/*.mjs`;
- `docs/architecture.md`, `docs/contract.md`, `docs/usage.md`, `docs/watch-loop-prompt.md`, `docs/release-checklist.md`, `docs/alternatives.md`, `docs/troubleshooting.md`;
- `docs/img/` (the four generated SVGs: `demo.svg`, `usage.svg`, `text-output.svg`, `json-output.svg`);
- `docs/entities-research/` (all real entity pages — `pr.md`, `issue.md`, `selectors.md`, etc., and the subtree `README.md`; **not** `_template.md`);
- `README.md`;
- `RUNBOOK.md`;
- `CHANGELOG.md`;
- `LICENSE`;
- `package.json`.

It should not contain:

- `test/`;
- `.github/`;
- `examples/` (source-repository documentation only; README links to the GitHub
  copy);
- `node_modules/`;
- `coverage/`;
- `state/`;
- local tarballs.
