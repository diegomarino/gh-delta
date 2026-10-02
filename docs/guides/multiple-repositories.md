# Several repositories

[Documentation](../README.md) · [Usage by task](../usage.md)

Pass a comma-separated list or repeat `--repo` to run independent ticks in
order. The JSON result is one aggregate; successful deltas include `repo` and
partial failures are reported without preventing later repositories from
advancing their own snapshots. Do not combine this mode with `--state-file`.

```bash
gh-delta --repo owner/api,owner/web --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/gh-delta/snapshots" --format text
```

Run from a source checkout:

```bash
git clone https://github.com/diegomarino/gh-delta.git
cd gh-delta
npm install
npm run check

node ./gh-delta.mjs --repo owner/repo --format text
```

The exact CLI reference lives in [CLI](../contract/cli.md#cli). The
machine-readable version is emitted by:

```bash
gh-delta --help-json
```
