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

// The PR #42 delta: a single item that exercises three distinct detail field
// groups (`ci`, `review`, and label add/remove) so `--detail` is shown off in
// one place. The fingerprints deliberately omit the ciChecks/reviewSummary
// summaries, so the ci/reviews details render the `opaque: true` fallback (the
// output of a first tick over a pre-summary snapshot).
const pr42 = withId({
  entity: 'pr',
  number: 42,
  title: 'Add billing webhook',
  headRefName: 'feature/billing-webhook',
  classes: ['ci-changed', 'review-changed'],
  from: {
    state: 'OPEN',
    ci: 'a1b2c3',
    review: 'CHANGES_REQUESTED',
    reviews: 'r-9f8e',
  },
  to: {
    state: 'OPEN',
    ci: 'd4e5f6',
    review: 'APPROVED',
    reviews: 'r-2c1d',
  },
});

const issue17 = withId({
  entity: 'issue',
  number: 17,
  title: 'Backfill customer imports',
  classes: ['relabeled'],
  from: { state: 'OPEN', labels: ['worker'] },
  to: { state: 'OPEN', labels: ['backend', 'worker'] },
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
/** Run 3 — the same PR #42 tick, `--format json --detail`. */
export const detailReport = Object.freeze({
  schemaVersion: 1,
  baseline: false,
  repo: REPO,
  monitorId: MONITOR,
  entities: ['pr', 'issue'],
  stateFile: STATE_FILE,
  at: AT,
  deltas: [pr42],
  summary: '1 delta(s)',
});
