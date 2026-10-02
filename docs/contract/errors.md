# Error Report Shape

[Documentation](../README.md) · [Contract reference](../contract.md)

Emitted with exit code `1` (transient) or `2` (permanent). It **does not** carry
`deltas`, `entities`, `results`, or `summary`. The snapshot is not written.

```json
{
  "schemaVersion": 2,
  "error": "--entities must include pr, issue, or both; got \"prs\"",
  "kind": "config",
  "hint": "Fix the command configuration, or run gh-delta doctor for a local diagnostic.",
  "repo": "owner/repo",
  "monitorId": "prs-5m",
  "at": "2026-07-01T12:00:00.000Z"
}
```

This bare, unenveloped shape is deliberately unchanged from before schema v2:
it applies only to a pre-flight failure raised **before any repo is known**
(bad flags, unresolvable `--repo`). A failure discovered after the repo is
known instead surfaces only inside that repo's own `results[].error` on an
otherwise-successful multi-repo report — see [Report Shape](report.md#report-shape).

- `schemaVersion` (number), `error` (string), `at` (string): always present.
- `hint` (string): always present and actionable. It is advisory rather than a
  stable enum: `config` points to configuration/doctor, `snapshot` to recovery
  (`gh-delta reset` for a pre-schema-v2 or invalid-shape snapshot), `github` to
  authentication/connectivity (and `read:org` when recognizable), `io` to
  directory permissions, `busy` to the competing monitor, `log` to the durable
  journal, and `rate-limit` to `resetAt`/quota.
- `kind` (string): one of `config`, `snapshot`, `github`, `io`, `busy`, `log`,
  `rate-limit`. This is a closed set while `report.schemaVersion === 2`, but
  forward-compatible like classes — treat unknown values as "something changed,
  inspect". `config`, `snapshot`, and `log` kinds map to exit `2`; `github`,
  `io`, `busy`, and `rate-limit` kinds map to exit `1`. This is where `--repo` derivation errors land too: no repo
  derivable from git remotes or `gh` is `kind: "config"` (exit `2`, permanent);
  a `gh` timeout while deriving `--repo` is `kind: "github"` (exit `1`,
  transient) — see the `--repo` bullet in [CLI](cli.md#cli). `busy` means the
  state-file lock is held by another run (or was unreadable and too recent to
  presume abandoned) — see [Lock Semantics](locks.md#lock-semantics). A `busy` error is
  raised **before any GitHub call**, so it is never mistaken for a failed
  fetch, and the snapshot is untouched. A schema-v1 (or otherwise pre-current)
  snapshot is `kind: "snapshot"`, hinting at `gh-delta reset` — it is never
  migrated in place.
- `repo`, `monitorId` (string): present once the corresponding flag has been
  parsed (absent for errors raised before that, e.g. an unknown option). `error`
  strings are human-readable and not a stable enum.
- `resetAt` (ISO-8601 UTC string): present **only** when `kind` is `rate-limit`
  because `--rate-limit-floor` found `resources.graphql.remaining` below the
  configured floor. It is the API's reset epoch normalized to UTC; it is absent
  for every other error, including a malformed or failed rate-limit request.
