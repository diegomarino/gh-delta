# Install and Run

[Documentation](../README.md) · [Usage by task](../usage.md)

Install globally:

```bash
npm install --global gh-delta
gh-delta --version
gh-delta --help
```

Run without installing:

```bash
npx gh-delta --repo owner/repo
```

## Zero-config repo

Inside a checkout with a GitHub `origin` (or `upstream`) remote, `--repo` can be
omitted entirely — `gh-delta` derives `owner/name` from the current directory's
git remote:

```bash
cd my-github-checkout
gh-delta --format text
```

Pass `--repo` explicitly to pin a repo, run outside a checkout, or override
derivation (e.g. `origin` points elsewhere than the repo you want to watch).
See the `--repo` bullet in [CLI](../contract/cli.md#cli) for the full precedence
(`origin` → `upstream` → `gh repo view` fallback) and the `repoSource` report
field.
