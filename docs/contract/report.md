# Report Shape

[Documentation](../README.md) · [Contract reference](../contract.md)

Success reports (exit `0` and `10`) use one envelope regardless of repository
count: `repos`/`results[]` are always present, `deltas` is the flattened union
across every repository, and there is no top-level `errors` array — a
per-repo failure lives only inside its own `results[].error`.

```json
{
  "schemaVersion": 2,
  "detectedAt": "2026-07-01T12:00:00.000Z",
  "monitorId": "prs-5m",
  "entities": ["pr"],
  "repos": ["owner/repo"],
  "results": [
    {
      "repo": "owner/repo",
      "baseline": false,
      "repoSource": "flag",
      "stateFile": "/tmp/gh-delta-user/repo-owner%2Frepo__monitor-prs-5m__pr.json",
      "rateLimit": { "cost": 8, "remaining": 4982, "resetAt": "2026-07-01T13:00:00.000Z" }
    }
  ],
  "deltas": [
    {
      "id": "a7c7fb531053f88bf5c237de83f130adb23ffe7490dec72c0103ccde6a1c0d1",
      "entity": "pr",
      "number": 42,
      "context": {
        "id": "PR_kwDOABCDEF",
        "title": "Add widget",
        "url": "https://github.com/owner/repo/pull/42",
        "author": "octocat",
        "createdAt": "2026-06-01T09:00:00Z",
        "headRefName": "feature/add-widget"
      },
      "classes": ["new-comments"],
      "changed": { "conversationComments": { "from": 1, "to": 3 } },
      "summary": {
        "ciRollup": "green",
        "reviewDecision": "review_required",
        "mergeable": "mergeable",
        "mergeStateStatus": "clean",
        "state": "open",
        "isDraft": false,
        "unresolvedReviewThreads": 0,
        "headSha": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c",
        "failedChecks": []
      },
      "from": { "conversationComments": 1, "...": "..." },
      "to": { "conversationComments": 3, "...": "..." }
    }
  ],
  "filteredDeltas": 0,
  "warnings": [],
  "summary": "1 delta(s)"
}
```

Field guarantees:

- `schemaVersion` (number): report shape version. Bumped **only** on a breaking
  change — a field removed or renamed. Additive changes (new optional keys on the
  report, a delta, or a fingerprint) do not bump it. Assert `schemaVersion === 2`.
- `detectedAt` (string): ISO-8601 UTC timestamp of the run.
- `monitorId` (string): echoes the flag.
- `entities` (string[]): the selected families, always in canonical order
  `["pr", "issue"]` regardless of the `--entities` input order.
- `repos` (string[]): the requested repositories in canonical (lowercased)
  order — always an array, one entry even for a single repository.
- `results` (array): one row per repository in this tick — see
  `REPORT_RESULT_FIELDS` in `gh-delta/contract`:
  - `repo` (string): the repository this row describes.
  - `baseline` (boolean): `true` on the first run for this repo's snapshot.
    Without `--baseline-emit-state`, `deltas` is always `[]` for that repo when
    `true` even though every tracked object is new — a baseline seeds memory,
    it does not report. With `--baseline-emit-state`, a baseline that observes
    at least one tracked open item instead carries `baseline-state` deltas
    (and the run exits `10`). Handle `baseline` distinctly from "no deltas"
    either way.
  - `repoSource` (`"flag"` | `"git-remote"` | `"gh"`): how `--repo` was
    resolved for this row — see the `--repo` bullet in [CLI](cli.md#cli).
  - `stateFile` (string): the resolved snapshot path for this repo — useful
    when the temp-dir default is in effect. The temp-dir default resolves
    under the OS temp dir — `/tmp/…` on Linux, `/var/folders/…/T/…` on macOS;
    trust this field rather than assuming `/tmp`.
  - `logFile` (string, optional): absolute path of the opt-in durable delta
    log for this repo. Present only when `--log` is supplied, including when
    `deltas` is empty.
  - `rateLimit` (object|null): `{cost, remaining, resetAt}` accumulated across
    every GraphQL call this tick for this repo, or `null` if none was made
    (e.g. an economical watch tick with zero watched PRs). An incomplete
    observation that already validated one or more GraphQL responses still
    reports those validated costs here; it never invents the cost of an
    unsuccessful request.
  - `error` (object, optional): present only on a per-repo failure —
    `{kind, message, hint, resetAt?}`. A partial multi-repo failure is visible
    only here; other repos' rows still report their own successful results.
- `deltas` (array): the flattened union across every repository, in `results`
  order. Empty on baseline and on no-change runs. Each carries an optional
  `delta.repo` in a multi-repository aggregate, identifying the repository
  that produced it.
- `filteredDeltas` (number): whole detected deltas suppressed by one or more
  attention filters. Always present (`0` when no attention filter ran).
  It does not count individual classes removed from a surviving delta.
- `warnings` (`{ label: string, reason: string }[]`): always present, possibly
  empty. An outpost POST that timed out or returned an error, or
  `origin`/`upstream` resolving to different repos while deriving `--repo`
  (`label: "repo"`; see the `--repo` bullet in [CLI](cli.md#cli)) both land here.
  Does not appear in text output as a `warnings` array — each entry is instead
  printed inline as `warning [<label>]: <reason>`. Does not affect the exit
  code.
- `summary` (string): **human-readable only.** Wording is not stable; do not
  parse it (it varies between "baseline established: N PRs, M issues" and
  "N delta(s)").

Continue with [delta fields and details](delta-fields.md), [summary fields](summary.md), and [errors](errors.md).
