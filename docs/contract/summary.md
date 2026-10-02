# Delta Summary schema

[Documentation](../README.md) · [Contract reference](../contract.md)

Always present on PR deltas with an observed `to` state — `--summaries` is a
deprecated no-op that changes nothing (see [Report Shape](report.md#report-shape)). The
`from`/`to` items carry the compared fingerprint used for change _detection_;
the `summary` object answers "is CI green?" or "what did reviewers decide?"
from the **same single observation** (no extra fetch). It is absent on issue
deltas and the missing lifecycle, and is a **sibling of `to`**, so `id` is
unaffected by it. It is an optional **hint**: a fail-closed consumer may
re-derive authoritative facts itself.

```json
{
  "ciRollup": "green",
  "reviewDecision": "approved",
  "mergeable": "mergeable",
  "mergeStateStatus": "clean",
  "state": "open",
  "isDraft": false,
  "unresolvedReviewThreads": 0,
  "headSha": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c",
  "failedChecks": []
}
```

Every field is a total function of the observed `to` state; the shape is fixed
(no field is ever omitted when `summary` is present).

| Field                     | Type    | Domain / Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ciRollup`                | enum    | `green` \| `failed` \| `pending` \| `none`. Rolled up from the CI checks with precedence `failed > pending > green`. **`none` means zero checks ran** — never conflated with `green`, so a fail-closed gate decides what "no CI" means.                                                                                                                                                                                                                                               |
| `reviewDecision`          | enum    | `approved` \| `changes_requested` \| `review_required` \| `none`. Normalized from GitHub `reviewDecision`. `none` covers both "no review-required rule" and "required but none submitted yet" — GitHub does not distinguish these here.                                                                                                                                                                                                                                               |
| `mergeable`               | enum    | `mergeable` \| `conflicting` \| `unknown`. `unknown` = GitHub has not finished recomputing mergeability (common right after a base-branch change). Deliberately **not** a boolean, so `conflicting` and "not computed" stay distinct.                                                                                                                                                                                                                                                 |
| `mergeStateStatus`        | enum    | `behind` \| `blocked` \| `clean` \| `dirty` \| `draft` \| `has_hooks` \| `unstable` \| `unknown`. GitHub's `mergeStateStatus` from the same observation. `unknown` = not reported / absent / unrecognized — fail-closed, meaning "not computed", exactly like `mergeable: unknown`. A PR can be `mergeable` yet `behind` its base (repos requiring the branch be up to date) or `blocked` by an unsatisfied protection rule, so this is deliberately **not** folded into `mergeable`. |
| `state`                   | enum    | `open` \| `closed` \| `merged`. Lowercased PR state.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isDraft`                 | boolean | Draft status, as a real boolean.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `unresolvedReviewThreads` | integer | Non-negative count of unresolved review threads (same value as the `to` fingerprint's field).                                                                                                                                                                                                                                                                                                                                                                                         |
| `headSha`                 | string  | The head commit SHA (git OID), under an unambiguous name. Empty string `""` if unobserved.                                                                                                                                                                                                                                                                                                                                                                                            |
| `failedChecks`            | array   | The failing subset of the same `to.fingerprint.checks` rollup, as `{name, runId, jobId, detailsUrl}`. `runId`/`jobId` are present only when `detailsUrl` parsed as a github.com Actions run/job URL, and are **omitted (never `null`)** otherwise. See the GitHub Enterprise note below.                                                                                                                                                                                              |

**GitHub Enterprise limitation (known, by design).** `runId`/`jobId` are parsed
only from `github.com` Actions check URLs (`.../actions/runs/<runId>/job/<jobId>`).
A GitHub Enterprise Server check's `detailsUrl` does not match that pattern, so
`failedChecks` rows from a GHES repo carry `detailsUrl` only, without
`runId`/`jobId`. The reason is structural, not an oversight: `--repo` is
validated as a bare `owner/name` (`lib/args.mjs`), so a repo's identity never
carries a host component for the fingerprint layer to anchor a host-aware
parsing pattern to. `runId`/`jobId` are **omitted, never `null`**, when the URL
does not parse — two representations of "no run id" would hash differently in
`changed`/detail diffs and churn `delta.id` on non-changes, which matters more
than distinguishing "not parsed" from "not applicable" here.

The field set and enum domains are also emitted machine-readably under
`output.deltaSummaryFields` and `output.deltaSummaryEnums` in `gh-delta --help-json`,
and are importable as `DELTA_SUMMARY_FIELDS` / `DELTA_SUMMARY_ENUMS` from
`gh-delta/contract` — enough to generate a Zod or JSON-Schema validator without
parsing this document. `summary` is additive and does **not** bump `schemaVersion`
(see [schemaVersion policy](schema-version.md#schemaversion-policy)).

When `--outpost-url` is combined with a PR delta, the same `summary` object is
mirrored onto the [outpost payload](outpost.md#outpost-payload-schema-v2) so webhook
consumers see the identical field.
