# Release Checklist

Use this checklist before publishing `gh-delta` to npm.

## Local Gate

Run:

```bash
npm ci --cache .npm-cache
npm run release:check
gh-delta --help
gh-delta --help-json
gh-delta --version
```

Expected:

- lint passes;
- Prettier reports every file as formatted;
- all Node tests pass;
- the coverage report completes;
- `npm pack --dry-run` lists only expected public package files;
- the CLI prints human help, JSON help, and version output, then exits `0`.

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
- update `CHANGELOG.md` with the final release date;
- tag the release after the publish commit.

## Package Contents

The package should contain:

- `gh-delta.mjs`;
- `lib/*.mjs`;
- `docs/*.md`;
- `README.md`;
- `RUNBOOK.md`;
- `CHANGELOG.md`;
- `LICENSE`;
- `package.json`.

It should not contain:

- `gh-delta-tick.mjs`;
- `test/`;
- `.github/`;
- `node_modules/`;
- `coverage/`;
- `state/`;
- local tarballs.
