# Per-delta templates

Run `./run.sh` for a deterministic local detector/read demo. It injects
GitHub observations, contacts no network, and removes its temporary state.
The JSON proof records baseline `0`, event `10`, quiet `0`, identical cursor
replay bytes, and quiet `0` after advancement.

For a real repository:

```sh
gh-delta --repo acme/widgets --monitor-id template-relay --state-dir ./state \
  --entities pr --log --format template --template '{repo} #{number} [{classes}]'
```

A first tick establishes a quiet baseline. Preserve exit `10` as a successful
tick with deltas; `1` is retryable and `2` needs repair. Initialize one cursor
per consumer using the `logFile` from an equivalent JSON tick:

```sh
gh-delta cursor set ./triage.cursor.json 0 --log-file "$LOG_FILE"
gh-delta read --cursor ./triage.cursor.json --advance --format template \
  --template 'seq={seq} {repo} #{number} [{classes}]'
```

`--advance` records consumption before external delivery. Templates do not
acknowledge delivery or cap output. See the [worked examples](../../docs/template-examples.md)
for file pinning, escaping, optional fields, and scheduler trust boundaries.
