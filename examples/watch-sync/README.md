# Atomic watch sync

Replace one complete local watch set without contacting GitHub. Redirect the
success JSON away from any detector event stream.

Check the producer first. A valid `end N` frame does not mean the producer
succeeded, and `pipefail` can report failure after sync has already committed.

```sh
if producer-command > /private/tmp/desired-watch.txt; then
  gh-delta watch sync --from /private/tmp/desired-watch.txt \
    --watch-dir ./state/watch > /private/tmp/watch-sync-result.json
fi
```

An intentional empty set requires both `end 0` and `--allow-empty`:

```sh
gh-delta watch sync --from empty-watch.txt --watch-dir ./state/watch --allow-empty
```

`--repo` is a default for input lines that omit `repo=`. It is not a partial
update. Entries for repositories absent from the input are removed. Do not pipe
sync into the detector.
