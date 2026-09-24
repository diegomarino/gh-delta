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

const REPO = 'owner/repo';

// Stamp the content-addressed id exactly as lib/cli.mjs run() does, so a fixture
// delta is byte-identical to a live one (id leads the object).
const withId = (delta) => ({ id: deltaId(deltaIdentity(REPO, delta)), ...delta });
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
  title: 'Add billing webhook',
  headRefName: 'feature/billing-webhook',
  author: 'alice',
  url: 'https://github.com/owner/repo/pull/42',
};
const pr42 = withId({
  entity: 'pr',
  number: 42,
  title: 'Add billing webhook',
  headRefName: 'feature/billing-webhook',
  author: 'alice',
  url: 'https://github.com/owner/repo/pull/42',
  classes: ['ci-changed', 'review-changed', 'review-requests-changed'],
  from: item(
    {
      state: 'open',
      checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
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
      checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
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
  title: 'Backfill customer imports',
  author: 'carol',
  url: 'https://github.com/owner/repo/issues/17',
};
const issue17 = withId({
  entity: 'issue',
  number: 17,
  title: 'Backfill customer imports',
  author: 'carol',
  url: 'https://github.com/owner/repo/issues/17',
  classes: ['relabeled'],
  from: item({ state: 'open', labels: ['worker'] }, issue17Context),
  to: item({ state: 'open', labels: ['backend', 'worker'] }, issue17Context),
});

// An unchanged open PR that has crossed the explicit inactivity threshold. Its
// UTC period is part of the public, content-addressed stale delta identity.
const pr88Context = {
  title: 'Refresh release notes',
  headRefName: 'docs/release-notes',
  author: 'bob',
  url: 'https://github.com/owner/repo/pull/88',
};
const pr88Stale = withId({
  entity: 'pr',
  number: 88,
  title: 'Refresh release notes',
  headRefName: 'docs/release-notes',
  author: 'bob',
  url: 'https://github.com/owner/repo/pull/88',
  classes: ['stale'],
  staleAt: '2026-07-01',
  from: item({ state: 'open', headSha: 'd0c5' }, pr88Context),
  to: item({ state: 'open', headSha: 'd0c5' }, pr88Context),
});

// lib/cli.mjs never puts a `warnings` key on the base report object (see
// run()); it is only spliced in by runCommand() when outpost delivery
// returned at least one non-empty warning. A live run therefore *omits*
// `warnings` entirely on the common path these fixtures depict, so the
// fixtures must omit it too (fixes audit finding F10.1, the "impossible
// warnings key").

/** Run 1 — zero-config baseline seed. */
export const baselineReport = Object.freeze({
  schemaVersion: 1,
  baseline: true,
  repo: REPO,
  repoSource: 'flag',
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  stateFile: STATE_FILE,
  at: AT_BASELINE,
  deltas: [],
  summary: 'baseline established: 1 PRs, 1 issues',
});

/** Run 2 — second tick, two deltas, text output. */
export const deltaReport = Object.freeze({
  schemaVersion: 1,
  baseline: false,
  repo: REPO,
  repoSource: 'flag',
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  stateFile: STATE_FILE,
  at: AT,
  deltas: [pr42, issue17],
  summary: '2 delta(s)',
});

// `entities` matches the flag-free `gh-delta --repo owner/repo --format json
// --detail` command rendered in generate-cast.mjs (no `--entities` flag) and
// the `__pr-issue` segment of STATE_FILE (fixes audit finding F10.2, the
// "impossible --entities echo").
/** Run 3 — PR #42 plus inactivity, `--format json --detail --stale-after 24h`. */
export const detailReport = Object.freeze({
  schemaVersion: 1,
  baseline: false,
  repo: REPO,
  repoSource: 'flag',
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  stateFile: STATE_FILE,
  at: AT,
  deltas: [pr42, pr88Stale],
  summary: '2 delta(s)',
});
