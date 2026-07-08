# Release Checklist

Use this checklist before publishing `gh-delta` to npm.

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

The package should contain exactly the files enumerated in `package.json#files`:

- `gh-delta.mjs`;
- `lib/*.mjs`;
- `docs/architecture.md`, `docs/contract.md`, `docs/watch-loop-prompt.md`, `docs/release-checklist.md`, `docs/alternatives.md`, `docs/troubleshooting.md`;
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
