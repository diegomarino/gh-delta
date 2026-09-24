# GraphQL query cost measurements

Status: measurement log, not public contract. `docs/contract.md`'s cost table
(owned by task E0) is the source of truth once published; this file records
the raw measurements behind it.

## F1 — `reviewThreads { comments { totalCount } } }` (task F1, schema-v2 epic)

The schema-v2 implementation plan estimated the PR observation page cost
would move 7 → 8 points when `comments { totalCount }` was added inside the
`reviewThreads(first: 100)` connection (landed in task R2, commit `bd91971`,
before F1 started). F1 measured this directly rather than trusting the
estimate.

**Method:** `GH_DELTA_E2E_RUN=1 node ./test/e2e/rate-limit-benchmark.mjs
diegomarino/gh-delta` for the current ("after") shape; a hand-issued
`gh api graphql` call reconstructing the exact pre-R2 `PR_QUERY`/`PR_FIELDS`
string from commit `c019db3` (R2's parent) for the "before" shape, both
against the same live repository (`diegomarino/gh-delta`, 1 open PR at
measurement time) with `rateLimit { cost remaining resetAt }` requested
alongside.

**Result:**

| query shape                                                        | measured cost |
| ------------------------------------------------------------------ | ------------- |
| before (no `comments { totalCount }` in `reviewThreads`)           | 8             |
| after (current, with `comments { totalCount }` in `reviewThreads`) | 8             |

Measured twice each, back to back, on 2026-09-24; both readings were
identical. **The field addition made no measurable difference at this
repo's current scale** (1 open PR, few review threads) — GitHub's
node-based GraphQL cost formula weights top-level connections
(`reviewThreads(first: 100)` itself, already present pre-R2) more heavily
than a scalar field nested one level inside an already-costed connection, so
adding `comments { totalCount }` per thread did not change the page's total
cost here. The plan's 7 → 8 estimate does not hold as a general rule at this
scale; it may become visible on a repository with materially more open PRs
and/or review threads per PR, where the formula's per-node multiplication
would surface the added nested field's weight. E0 should re-measure against
a higher-volume repository before publishing a cost table entry, or publish
the measured 8→8 result with this caveat.
