# Measured query costs

[Documentation](../README.md) · [Contract reference](../contract.md)

Query cost against GitHub's GraphQL API is charged by requested shape, not by
rows returned, so it must be measured live rather than computed. These figures
come from `test/e2e/rate-limit-benchmark.mjs` (`npm run e2e:rate-limit-benchmark`,
opt-in via `GH_DELTA_E2E_RUN=1` since it spends real quota), run against
`diegomarino/gh-delta` on 2026-09-24 with 1 open PR and few review threads:

| Query shape                                              | Measured cost | Note                                                   |
| -------------------------------------------------------- | ------------- | ------------------------------------------------------ |
| PR observation page (open-only, current schema-v2 shape) | 8             | Includes `reviewThreads { comments { totalCount } } }` |
| PR observation page (pre-R2 shape, for comparison)       | 8             | Without the nested `comments { totalCount }`           |
| Issue observation page (open-only)                       | 2             | Unchanged by schema v2; last measured at 0.5.0         |

**Caveat — this is not a general guarantee.** The schema-v2 implementation plan
estimated the PR page would move 7 → 8 points when the nested review-thread
comment count was added; measured live it was **8 → 8, no change**, because
GitHub's node-based cost formula weights top-level connections
(`reviewThreads(first: 100)` itself) more heavily than a scalar field nested
one level inside an already-costed connection. That measurement was taken
against a repository with exactly one open PR and few review threads — a
repository with materially more open PRs and/or review threads per PR could see
the nested field's weight surface differently. Re-run the harness against your
own repository's scale before treating these numbers as a budget ceiling.
