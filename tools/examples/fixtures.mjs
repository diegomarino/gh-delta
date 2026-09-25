// Frozen report fixtures that drive every README example artifact.
//
// These are the single source of truth for the demo cast and the static Output
// Sample SVGs. They are fed to the *real* renderers (lib/text-output.mjs and
// JSON.stringify), so the rendered output is byte-identical to a live `gh-delta`
// run without needing a network or a `gh` binary.
//
// `from`/`to` states are internally consistent on purpose (fixes audit finding
// D5, the "impossible delta"). test/examples.test.mjs asserts these objects
// still cover the frozen contract field lists, so a schema change fails loudly.
import { deltaId, deltaIdentity } from '../../lib/fingerprint.mjs';
import { diffFingerprint } from '../../lib/diff.mjs';
import { deltaSummary } from '../../lib/summary.mjs';

const REPO = 'owner/repo';

// Stamp the content-addressed id and the always-on changed/summary fields
// exactly as lib/cli.mjs's run()/enrichDelta do, so a fixture delta is
// byte-identical to a live one.
const withId = (delta) => {
  const withRepo = { id: deltaId(deltaIdentity(REPO, delta)), repo: REPO, ...delta };
  withRepo.changed = diffFingerprint(withRepo.from?.fingerprint, withRepo.to?.fingerprint);
  withRepo.summary = deltaSummary(withRepo);
  // Public contract: from/to are the bare fingerprint, not the full item --
  // see lib/cli.mjs's matching strip step.
  withRepo.from = withRepo.from?.fingerprint ?? null;
  withRepo.to = withRepo.to?.fingerprint ?? null;
  return withRepo;
};
// Zero-config default: `--monitor-id` derives to `host-<sha1(hostname)[:12]>`.
// A realistic frozen value so the demo command can stay flag-free yet honest.
const MONITOR = 'host-9c1f7b2a4e83';
const STATE_FILE = '/tmp/gh-delta-user/repo-owner%2Frepo__monitor-host-9c1f7b2a4e83__pr-issue.json';
const AT = '2026-07-01T12:05:00.000Z';
const AT_BASELINE = '2026-07-01T12:00:00.000Z';

// Snapshot items store `{ fingerprint, context, meta }` (schema v2 -- see
// lib/snapshot.mjs); a delta's `from`/`to` are items too. `item()` wraps a
// bare compared-fields fragment into that shape for these fixtures.
const item = (fingerprint, context = {}) => ({
  fingerprint,
  context,
  meta: { seenAt: AT, changedAt: AT, ticksSinceChange: 0, missingTicks: 0, staleEmittedFor: null },
});

// The PR #42 delta: a single item that exercises three distinct detail field
// groups (`checks`, `reviewDecision`/`reviews`, and the reviewRequests
// add/remove set diff) so `--detail` is shown off in one place. The reviewer
// approving satisfies their pending request, so `review-changed` and
// `review-requests-changed` co-occur — the exact interplay the contract
// documents.
const pr42Context = {
  id: 'PR_pr42',
  title: 'Add billing webhook',
  headRefName: 'feature/billing-webhook',
  author: 'alice',
  createdAt: '2026-06-28T09:00:00Z',
  url: 'https://github.com/owner/repo/pull/42',
};
const pr42 = withId({
  entity: 'pr',
  number: 42,
  context: pr42Context,
  classes: ['ci-changed', 'review-changed', 'review-requests-changed'],
  from: item(
    {
      state: 'open',
      checks: [
        {
          name: 'build',
          kind: 'check',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: 'https://github.com/owner/repo/actions/runs/1234567890/job/2345678901',
          runId: '1234567890',
          jobId: '2345678901',
        },
      ],
      reviewDecision: 'changes_requested',
      reviews: [
        {
          id: 'PRR_9f8e',
          author: 'bob',
          state: 'changes_requested',
          submittedAt: '2026-06-30T09:00:00Z',
          commit: 'a1b2c3',
        },
      ],
      reviewRequests: ['alice'],
    },
    pr42Context,
  ),
  to: item(
    {
      state: 'open',
      checks: [
        {
          name: 'build',
          kind: 'check',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://github.com/owner/repo/actions/runs/1234567891/job/2345678902',
          runId: '1234567891',
          jobId: '2345678902',
        },
      ],
      reviewDecision: 'approved',
      reviews: [
        {
          id: 'PRR_2c1d',
          author: 'bob',
          state: 'approved',
          submittedAt: '2026-07-01T12:00:00Z',
          commit: 'd4e5f6',
        },
      ],
      reviewRequests: [],
    },
    pr42Context,
  ),
});

const issue17Context = {
  id: 'I_issue17',
  title: 'Backfill customer imports',
  author: 'carol',
  createdAt: '2026-06-20T09:00:00Z',
  url: 'https://github.com/owner/repo/issues/17',
};
const issue17 = withId({
  entity: 'issue',
  number: 17,
  context: issue17Context,
  classes: ['relabeled'],
  from: item({ state: 'open', labels: ['worker'] }, issue17Context),
  to: item({ state: 'open', labels: ['backend', 'worker'] }, issue17Context),
});

// An unchanged open PR that has crossed the explicit inactivity threshold. Its
// UTC period is part of the public, content-addressed stale delta identity.
const pr88Context = {
  id: 'PR_pr88',
  title: 'Refresh release notes',
  headRefName: 'docs/release-notes',
  author: 'bob',
  createdAt: '2026-06-25T09:00:00Z',
  url: 'https://github.com/owner/repo/pull/88',
};
const pr88Stale = withId({
  entity: 'pr',
  number: 88,
  context: pr88Context,
  classes: ['stale'],
  staleAt: '2026-07-01',
  from: item({ state: 'open', headSha: 'd0c5' }, pr88Context),
  to: item({ state: 'open', headSha: 'd0c5' }, pr88Context),
});

// PR #51: one tick moved both conversationComments and reviewComments --
// exactly the distinction F1 exists to make legible (a conversation reply
// vs. a reply inside an existing review thread, split into their own
// classes instead of one ambiguous aggregate).
const pr51Context = {
  id: 'PR_pr51',
  title: 'Paginate the audit log endpoint',
  headRefName: 'feature/audit-log-pagination',
  author: 'dave',
  createdAt: '2026-06-15T09:00:00Z',
  url: 'https://github.com/owner/repo/pull/51',
};
const pr51Comments = withId({
  entity: 'pr',
  number: 51,
  context: pr51Context,
  classes: ['new-comments', 'review-comments-added'],
  from: item(
    {
      state: 'open',
      conversationComments: 1,
      reviewComments: 2,
      threads: [{ id: 'PRRT_1', resolved: false, comments: 2 }],
    },
    pr51Context,
  ),
  to: item(
    {
      state: 'open',
      conversationComments: 2,
      reviewComments: 3,
      threads: [{ id: 'PRRT_1', resolved: false, comments: 3 }],
    },
    pr51Context,
  ),
});

// lib/cli.mjs never puts a `warnings` key beyond the always-on empty array on
// the base report object; outpost delivery warnings (spliced in by
// runCommand -- see run()) are the only thing that can make it non-empty. A
// live run therefore has `warnings: []` on the common path these fixtures
// depict, so the fixtures do too.
function result(overrides = {}) {
  return {
    repo: REPO,
    baseline: false,
    repoSource: 'flag',
    stateFile: STATE_FILE,
    rateLimit: null,
    ...overrides,
  };
}

/** Run 1 — zero-config baseline seed. */
export const baselineReport = Object.freeze({
  schemaVersion: 2,
  detectedAt: AT_BASELINE,
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  repos: [REPO],
  results: [result({ baseline: true })],
  deltas: [],
  filteredDeltas: 0,
  warnings: [],
  summary: 'baseline established: 1 PRs, 1 issues',
});

/** Run 2 — second tick, three deltas, text output. */
export const deltaReport = Object.freeze({
  schemaVersion: 2,
  detectedAt: AT,
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  repos: [REPO],
  results: [result()],
  deltas: [pr42, issue17, pr51Comments],
  filteredDeltas: 0,
  warnings: [],
  summary: '3 delta(s)',
});

// `entities` matches the flag-free `gh-delta --repo owner/repo --format json
// --detail` command rendered in generate-cast.mjs (no `--entities` flag) and
// the `__pr-issue` segment of STATE_FILE (fixes audit finding F10.2, the
// "impossible --entities echo").
/** Run 3 — PR #42 plus inactivity, `--format json --detail --stale-after 24h`. */
export const detailReport = Object.freeze({
  schemaVersion: 2,
  detectedAt: AT,
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  repos: [REPO],
  results: [result()],
  deltas: [pr42, pr88Stale],
  filteredDeltas: 0,
  warnings: [],
  summary: '2 delta(s)',
});
