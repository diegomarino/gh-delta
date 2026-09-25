// Guard: every field catalog lib/contract.mjs exports is documentation
// shaped like code -- nothing at runtime reads them to build the actual
// shapes, so nothing stops them from drifting away from what real output
// carries. This has already happened twice: AGENT_COMPACT_*/AGENT_NDJSON_END_FIELDS
// went stale for an entire epic, and a later round of this same guard
// covered only 4 of the 22 catalogs, leaving real drift undetected in the
// rest (REGISTRY_ENTRY_FIELDS missing `watchDir`; LIST_MONITOR_FIELDS
// missing `registryEntry`/`watchDir`; CURSOR_SET_REPORT_FIELDS and
// WAIT_REPORT_FIELDS both listing a phantom `repo` that no code path can
// ever emit; WAIT_REPORT_FIELDS also missing `warnings`, which the exact
// same generic JSON-merge-if-nonempty logic every other subcommand shares
// can attach to it too).
//
// A hand-written list of "catalogs to check" drifts exactly like the
// catalogs themselves did -- so this file does not keep one. It DISCOVERS
// every field catalog directly from lib/contract.mjs's own exports (every
// export named `*_FIELDS` whose value is a flat array of strings -- the
// convention every one of the 22 existing catalogs follows with zero
// exceptions; ERROR_KINDS/DELTA_CLASSES are VALUE enums and are named
// accordingly, not field-name lists, and DELTA_SUMMARY_ENUMS/
// DELTA_DETAIL_FIELDS_BY_CLASS are maps, excluded by Array.isArray alone)
// and asserts that COVERAGE below has an entry for every one of them. Add a
// catalog to lib/contract.mjs without adding its deriver here, and the
// first test in this file fails -- that property is the whole point.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/cli.mjs';
import * as contract from '../lib/contract.mjs';
import { readDeltaLog, setCursorAtomic } from '../lib/deltalog.mjs';
import { compactReport, ndjsonReport } from '../lib/compact-output.mjs';
import { listMonitors } from '../lib/list.mjs';
import { registerMonitor } from '../lib/registry.mjs';
import { snapshotPath, writeSnapshotAtomic } from '../lib/snapshot.mjs';
import { watchDirPath } from '../lib/watch.mjs';

function isFieldCatalog(name, value) {
  return (
    name.endsWith('FIELDS') && Array.isArray(value) && value.every((v) => typeof v === 'string')
  );
}
const DISCOVERED_CATALOGS = Object.keys(contract)
  .filter((name) => isFieldCatalog(name, contract[name]))
  .sort();

// `warnings` on read/wait's report is never actually set on `result.report`
// itself (see runRead/runWait: it is returned as a SIBLING field, `{report,
// warnings}`, not merged in) -- runCommand's generic merge-if-nonempty logic
// (its last branch) only folds it into the rendered `.output` JSON string, a
// separate code path `.report` never passes through. So `.report` alone
// cannot prove `warnings` reachable; this parses the same JSON text a real
// consumer of `--format json` actually receives.
function publishedReport(result) {
  return JSON.parse(result.output);
}

const REPO = 'acme/widgets';
const MONITOR_ID = 'contract-fields';
const T0 = '2026-02-01T00:00:00.000Z';
const T2H = '2026-02-01T02:00:00.000Z';
const T3H = '2026-02-01T03:00:00.000Z';

function pr1(overrides = {}) {
  return {
    number: 1,
    id: 'PR_1',
    title: 'Add widget factory',
    url: 'https://github.com/acme/widgets/pull/1',
    author: 'alice',
    createdAt: '2026-01-01T09:00:00Z',
    headRefName: 'feature/widget-factory',
    state: 'open',
    updatedAt: T0,
    isDraft: false,
    headSha: 'aaaaaaa1',
    baseRef: 'main',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'review_required',
    checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'success' }],
    reviews: [],
    threads: [],
    conversationComments: 2,
    reviewComments: 0,
    recentComments: [],
    labels: [{ name: 'enhancement' }],
    assignees: ['alice'],
    reviewRequests: ['bob'],
    ...overrides,
  };
}

function pr2New() {
  return {
    number: 2,
    id: 'PR_2',
    title: 'Add gadget',
    url: 'https://github.com/acme/widgets/pull/2',
    author: 'bob',
    createdAt: T2H,
    headRefName: 'feature/gadget',
    state: 'open',
    updatedAt: T2H,
    isDraft: false,
    headSha: 'bbbbbbb1',
    baseRef: 'main',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'none',
    checks: [],
    reviews: [],
    threads: [],
    conversationComments: 0,
    reviewComments: 0,
    recentComments: [],
    labels: [],
    assignees: [],
    reviewRequests: [],
  };
}

function issue10(overrides = {}) {
  return {
    number: 10,
    id: 'ISSUE_10',
    title: 'Widgets sometimes squeak',
    url: 'https://github.com/acme/widgets/issues/10',
    author: 'carol',
    createdAt: '2026-01-01T08:00:00Z',
    state: 'open',
    updatedAt: T0,
    labels: [{ name: 'bug' }],
    assignees: ['carol'],
    conversationComments: 1,
    recentComments: [],
    ...overrides,
  };
}

// Builds every real fixture this guard checks against, exactly once, via the
// real CLI and real library functions -- never a hand-authored literal
// standing in for what the code would produce. Returns the bag every
// COVERAGE deriver below reads from.
async function buildFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-'));
  const stateFile = join(dir, 'state.json');
  const detectorArgv = () => [
    '--repo',
    REPO,
    '--monitor-id',
    MONITOR_ID,
    '--state-file',
    stateFile,
    '--log',
    '--detail',
    '--enrich',
    'comments',
    '--stale-after',
    '1h',
  ];

  const tick1 = await runCommand(detectorArgv(), {
    fetchPRs: () => ({ rows: [pr1()], rateLimit: null }),
    fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
    now: () => T0,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(tick1.code, 0);

  const tick2 = await runCommand(detectorArgv(), {
    fetchPRs: () => ({
      rows: [
        pr1({ conversationComments: 3, recentComments: [{ id: 'C_1', body: 'ping @bob' }] }),
        pr2New(),
      ],
      rateLimit: null,
    }),
    fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
    fetchEnrichment: (_kind, ids) => ({
      rows: [{ id: ids[0], author: 'alice', createdAt: T2H, body: 'ping @bob' }],
      rateLimit: null,
    }),
    now: () => T2H,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(tick2.code, 10);

  const tick3 = await runCommand(detectorArgv(), {
    fetchPRs: () => ({
      rows: [
        pr1({
          conversationComments: 3,
          // Same check name, different conclusion: triggers `ci-changed` with
          // a NAMED `changed` entry (see diffSummaries) -- DELTA_DETAIL_FIELDS'
          // `changed` key has no other real trigger in this fixture set.
          checks: [{ name: 'build', kind: 'check', status: 'completed', conclusion: 'failure' }],
          // Triggers `relabeled`, whose detail row always carries `added`/
          // `removed` (see pushSetDelta) -- the only real trigger for those
          // two DELTA_DETAIL_FIELDS keys in this fixture set.
          labels: [{ name: 'urgent' }],
        }),
      ],
      rateLimit: null,
    }),
    fetchIssues: () => ({ rows: [issue10()], rateLimit: null }),
    now: () => T3H,
    env: { GH_DELTA_NO_REGISTRY: '1' },
  });
  assert.equal(tick3.code, 10);

  const failed = await runCommand(
    ['--repo', REPO, '--monitor-id', MONITOR_ID, '--state-file', stateFile],
    {
      fetchPRs: () => ({ rows: [], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      readSnapshot: () => {
        throw new Error('invalid snapshot JSON');
      },
      now: () => T3H,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(failed.code, 2);

  // A real delta log record and cursor round-trip: `read --advance` writes
  // a real cursor file this guard reads back, unparsed.
  const logFile = tick2.report.results[0].logFile;
  const logRecords = readDeltaLog(logFile, { afterSeq: 0 }).entries;
  const cursorPath = join(dir, 'cursor.json');
  // `read` requires a pre-existing cursor (it has no --log-file flag of its
  // own to initialize one -- that is `cursor set`'s job); seed one pointing
  // at seq 0, matching how an operator actually starts reading a log they
  // have never consumed before.
  setCursorAtomic(cursorPath, { cursorVersion: 1, logFile, seq: 0 });
  const readAdvanced = await runCommand(['read', '--cursor', cursorPath, '--advance'], {
    now: () => T3H,
  });
  assert.equal(readAdvanced.code, 10);
  const realCursorFile = JSON.parse(readFileSync(cursorPath, 'utf8'));

  // A separate, minimal log for `cursor set` / `log compact` / `reset`,
  // since those mutate/delete state this guard must not entangle with the
  // detector fixtures above.
  const auxDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-aux-'));
  const auxStateFile = join(auxDir, 'state.json');
  const auxLogFile = join(auxDir, 'state.json.deltalog.ndjson');
  const auxTick1 = await runCommand(
    [
      '--repo',
      'aux/repo',
      '--monitor-id',
      'aux',
      '--state-file',
      auxStateFile,
      '--log',
      '--entities',
      'pr',
    ],
    {
      fetchPRs: () => ({ rows: [{ ...pr1(), number: 1 }], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T0,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(auxTick1.code, 0);
  const auxTick2 = await runCommand(
    [
      '--repo',
      'aux/repo',
      '--monitor-id',
      'aux',
      '--state-file',
      auxStateFile,
      '--log',
      '--entities',
      'pr',
    ],
    {
      fetchPRs: () => ({
        rows: [{ ...pr1(), number: 1, state: 'closed', updatedAt: T2H }],
        rateLimit: null,
      }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T2H,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(auxTick2.code, 10);
  // A third real state change (reopened), so the log has TWO real records
  // (seq 1, seq 2) before compact prunes -- `--keep 1` is a no-op on a
  // single-record log, so a genuine retention-warning trigger below needs at
  // least two.
  const auxTick3 = await runCommand(
    [
      '--repo',
      'aux/repo',
      '--monitor-id',
      'aux',
      '--state-file',
      auxStateFile,
      '--log',
      '--entities',
      'pr',
    ],
    {
      fetchPRs: () => ({
        rows: [{ ...pr1(), number: 1, state: 'open', updatedAt: T3H }],
        rateLimit: null,
      }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T3H,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(auxTick3.code, 10);

  const cursorSetPath = join(auxDir, 'aux-cursor.json');
  const cursorSet = await runCommand(
    ['cursor', 'set', cursorSetPath, '1', '--log-file', auxLogFile],
    { now: () => T3H },
  );
  assert.equal(cursorSet.code, 0);

  const compact = await runCommand(
    [
      'log',
      'compact',
      '--repo',
      'aux/repo',
      '--monitor-id',
      'aux',
      '--state-file',
      auxStateFile,
      '--keep',
      '1',
    ],
    { now: () => T3H },
  );
  assert.equal(compact.code, 0);

  // A cursor left at seq 0, read AFTER compact has pruned the log's earlier
  // records: the only real trigger for READ_REPORT_FIELDS' `warnings`
  // (runRead's own retention check, `cursor.seq + 1 < scanned.firstSeq`).
  const readRetentionCursorPath = join(auxDir, 'read-retention-cursor.json');
  setCursorAtomic(readRetentionCursorPath, { cursorVersion: 1, logFile: auxLogFile, seq: 0 });
  const readRetentionWarning = await runCommand(['read', '--cursor', readRetentionCursorPath], {
    now: () => T3H,
  });
  assert.equal(readRetentionWarning.code, 10);
  assert.ok(readRetentionWarning.warnings?.length, 'compacting past seq 0 must warn on read');

  const reset = await runCommand(
    ['reset', '--repo', 'aux/repo', '--monitor-id', 'aux', '--state-file', auxStateFile, '--yes'],
    { now: () => T3H },
  );
  assert.equal(reset.code, 0);

  // wait: one real success (repos/monitorId/deltas + a real attention-filter
  // fail-open warning) and one real transient failure (errors).
  const waitDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-wait-'));
  const waitStateFile = join(waitDir, 'state.json');
  const waitBefore = {
    ...pr1(),
    reviewComments: 1,
    threads: [{ id: 'T1', resolved: false, comments: 1 }],
  };
  const waitAfter = {
    ...waitBefore,
    updatedAt: T2H,
    reviewComments: 3,
    threads: [{ id: 'T1', resolved: false, comments: 3 }],
  };
  const waitSeedSnapshot = {
    pr: {
      1: {
        fingerprint: waitBefore,
        context: {},
        meta: {
          seenAt: T0,
          changedAt: T0,
          ticksSinceChange: 0,
          missingTicks: 0,
          staleEmittedFor: null,
        },
      },
    },
    issue: {},
    meta: {
      schemaVersion: 2,
      ghDeltaVersion: '0.0.0-test',
      repo: REPO,
      monitorId: 'wait-monitor',
      entities: ['pr', 'issue'],
      scope: 'poll',
      horizon: T0,
      createdAt: T0,
      updatedAt: T0,
    },
  };
  const waitSuccess = await runCommand(
    [
      'wait',
      '--repo',
      REPO,
      '--monitor-id',
      'wait-monitor',
      '--state-file',
      waitStateFile,
      '--timeout',
      '1s',
      '--interval',
      '1s',
      '--until',
      'review-comments-added',
      '--ignore-authors',
      'bot',
    ],
    {
      acquireLock: () => ({ ok: true, token: 't' }),
      releaseLock: () => ({ ok: true }),
      assertLockOwned: () => true,
      readSnapshot: () => waitSeedSnapshot,
      writeSnapshotAtomic: () => {},
      fetchPRs: () => ({ rows: [waitAfter], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T0,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(waitSuccess.code, 10);

  const waitFailed = await runCommand(
    [
      'wait',
      '--repo',
      REPO,
      '--monitor-id',
      'wait-monitor-2',
      '--state-file',
      join(waitDir, 'state2.json'),
      '--timeout',
      '1s',
      '--interval',
      '1s',
      '--until',
      'merged',
    ],
    {
      acquireLock: () => ({ ok: true, token: 't' }),
      releaseLock: () => ({ ok: true }),
      assertLockOwned: () => true,
      fetchPRs: () => {
        throw new Error('gh: connection reset');
      },
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T0,
      env: { GH_DELTA_NO_REGISTRY: '1' },
    },
  );
  assert.equal(waitFailed.code, 1);

  // list/registry: a real run with --watch-dir and the registry pointed at
  // our own temp dir (never the operator's real one), then `list` scanning
  // the same state-dir, so the merged entry carries BOTH `registryEntry`
  // (from the state-dir scan) and `watchDir` (from the registry) together.
  const listDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-list-'));
  const listStateDir = join(listDir, 'state');
  const registryDir = join(listDir, 'registry');
  const watchDir = join(listDir, 'watch');
  mkdirSync(listStateDir, { recursive: true });
  mkdirSync(watchDir, { recursive: true });
  writeFileSync(
    join(watchDir, 'pr-1.json'),
    '{"entity":"pr","number":1,"until":"merged","addedAt":"2026-02-01T00:00:00.000Z"}\n',
  );
  const listTick = await runCommand(
    [
      '--repo',
      'list/repo',
      '--monitor-id',
      'list-monitor',
      '--state-dir',
      listStateDir,
      '--watch-dir',
      watchDir,
    ],
    {
      // A watch entry already exists (written above), so this run is
      // economical (--watch-dir, all-PR, <=10 entries): it fetches via
      // fetchPRsByNumber, not fetchPRs.
      fetchPRsByNumber: () => ({ rows: [{ ...pr1(), number: 1 }], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T0,
      env: { GH_DELTA_REGISTRY_DIR: registryDir },
    },
  );
  assert.equal(listTick.code, 0, listTick.output);
  const listResult = await runCommand(['list', '--state-dir', listStateDir], {
    now: () => T2H,
    env: { GH_DELTA_REGISTRY_DIR: registryDir },
  });
  assert.equal(listResult.code, 0);
  // `list` without --state-dir consults the registry as its OWN source (see
  // lib/list.mjs's mergeRegistry "registry-only" branch) -- point THIS call
  // at an economical (PR-only, --watch-dir) scan whose state-dir it never
  // sees directly, so the merged monitor comes from the registry alone.
  const listRegistryOnlyDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-list-reg-'));
  const listRegistryOnlyState = join(listRegistryOnlyDir, 'state');
  mkdirSync(listRegistryOnlyState, { recursive: true });
  const registryOnlyTick = await runCommand(
    [
      '--repo',
      'registry-only/repo',
      '--monitor-id',
      'registry-only-monitor',
      '--state-dir',
      listRegistryOnlyState,
    ],
    {
      fetchPRs: () => ({ rows: [{ ...pr1(), number: 1 }], rateLimit: null }),
      fetchIssues: () => ({ rows: [], rateLimit: null }),
      now: () => T0,
      env: { GH_DELTA_REGISTRY_DIR: registryDir },
    },
  );
  assert.equal(registryOnlyTick.code, 0);
  const listRegistryOnlyResult = await runCommand(
    ['list', '--state-dir', listStateDir], // a DIFFERENT state-dir than registryOnlyTick used
    { now: () => T3H, env: { GH_DELTA_REGISTRY_DIR: registryDir } },
  );
  assert.equal(listRegistryOnlyResult.code, 0);

  // registry/list corner fields (`error`, `stale`, `watchDir`, `watchError`):
  // runList's own --state-dir flag deliberately disables registry merge (see
  // lib/cli.mjs's `values['state-dir'] ? null : defaultRegistryDir(...)`), so
  // there is no argv path that can drive watchDir-from-registry through the
  // CLI without hijacking the operator's real per-user default state/registry
  // dirs. listMonitors/registerMonitor are the exact real functions runList/
  // registerAttempt delegate to (this is the same pattern test/list.test.mjs
  // itself uses for these scenarios) -- calling them directly here is not a
  // mock, it drives the real merge/scan logic with real files on disk.
  const regStateDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-reg-state-'));
  const regRegistryDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-reg-registry-'));
  const regEnv = { GH_DELTA_REGISTRY_DIR: regRegistryDir };
  const regMeta = (overrides) => ({
    schemaVersion: 2,
    ghDeltaVersion: '0.0.0-test',
    scope: 'watch-pr',
    horizon: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
  const regItem = () => ({
    fingerprint: { state: 'open' },
    context: {},
    meta: {
      seenAt: T0,
      changedAt: T0,
      ticksSinceChange: 0,
      missingTicks: 0,
      staleEmittedFor: null,
    },
  });

  // Monitor A: scanned locally (-> registryEntry: true) AND registered with an
  // explicit watchDir (-> watchDir merged in from the registry): the two
  // fields this whole fixture exists to prove reachable.
  const aPath = snapshotPath('registry/a', 'monitor-a', 'pr', regStateDir);
  writeSnapshotAtomic(aPath, {
    pr: { 1: regItem() },
    issue: {},
    meta: regMeta({ repo: 'registry/a', monitorId: 'monitor-a', entities: ['pr'] }),
  });
  const aWatchDir = mkdtempSync(join(tmpdir(), 'gh-delta-contract-fields-reg-watchdir-'));
  // Capture the REAL entry object registerMonitor writes (and returns) --
  // REGISTRY_ENTRY_FIELDS' coverage below reads straight from this, not a
  // hand-built projection of it (see that deriver's comment for why: a
  // projection can stay green on exactly the drift it exists to catch).
  const { entry: registryEntryA } = registerMonitor({
    repo: 'registry/a',
    monitorId: 'monitor-a',
    entities: ['pr'],
    scope: 'watch-pr',
    stateFile: aPath,
    watchDir: aWatchDir,
    lastRun: T0,
    env: regEnv,
  });

  // Monitor B: registered, but its snapshot has since vanished -> `stale: true`.
  const { entry: registryEntryB } = registerMonitor({
    repo: 'registry/b',
    monitorId: 'monitor-b',
    entities: ['pr'],
    stateFile: join(regStateDir, 'gone.json'),
    lastRun: T0,
    env: regEnv,
  });

  // Monitor C: a snapshot file that fails to parse -> `error` + snapshotStatus
  // 'corrupt' (scanStateDir's readSnapshot-throws branch).
  const cPath = snapshotPath('registry/c', 'monitor-c', 'pr', regStateDir);
  writeFileSync(cPath, '{not valid json');

  // Monitor D: a valid local snapshot whose watch directory holds an
  // unreadable entry -> `watchError` (addWatchCount's readWatch-throws branch).
  const dPath = snapshotPath('registry/d', 'monitor-d', 'pr', regStateDir);
  writeSnapshotAtomic(dPath, {
    pr: {},
    issue: {},
    meta: regMeta({ repo: 'registry/d', monitorId: 'monitor-d', entities: ['pr'] }),
  });
  const dWatchDir = watchDirPath('registry/d', 'monitor-d', regStateDir);
  mkdirSync(dWatchDir, { recursive: true });
  writeFileSync(join(dWatchDir, 'issue-1.json'), '{bad');

  const { monitors: registryMonitors } = listMonitors(regStateDir, {
    now: () => T2H,
    registryDir: regRegistryDir,
  });
  assert.ok(
    registryMonitors.some((m) => m.watchDir),
    'monitor A must surface watchDir',
  );
  assert.ok(
    registryMonitors.some((m) => m.stale),
    'monitor B must surface stale',
  );
  assert.ok(
    registryMonitors.some((m) => m.error),
    'monitor C must surface error',
  );
  assert.ok(
    registryMonitors.some((m) => m.watchError),
    'monitor D must surface watchError',
  );

  // AGENT_* catalogs: rendered from the SAME real tick2/failed reports
  // through the real compactReport/ndjsonReport functions -- a happy
  // multi-optional-field record and a real error record, matching the
  // equivalent unit-level guard in test/compact-output.test.mjs.
  const agentCompactHappy = compactReport(tick2.report, 10, [], { detail: true, full: true });
  // tick3's report (unlike tick2's) carries a real `missing`-class delta
  // (pr2New vanishes between tick2 and tick3) -- the only real trigger for
  // AGENT_COMPACT_DELTA_FIELDS'/DELTA_FIELDS' `missingTicks` in this fixture
  // set, so it needs its own compact render alongside tick2's.
  const agentCompactHappy3 = compactReport(tick3.report, 10, [], { detail: true, full: true });
  const agentCompactError = compactReport(failed.report, 2, []);
  const agentNdjsonHappyEnd = ndjsonReport(tick2.report, 10, [], { detail: true, full: true })
    .trimEnd()
    .split('\n')
    .map(JSON.parse)
    .at(-1);
  const agentNdjsonErrorEnd = ndjsonReport(failed.report, 2, [])
    .trimEnd()
    .split('\n')
    .map(JSON.parse)
    .at(-1);

  return {
    dir,
    tick1,
    tick2,
    tick3,
    failed,
    logRecords,
    realCursorFile,
    readAdvanced,
    readRetentionWarning,
    cursorSet,
    compact,
    reset,
    waitSuccess,
    waitFailed,
    listResult,
    listRegistryOnlyResult,
    registryMonitors,
    registryEntryA,
    registryEntryB,
    agentCompactHappy,
    agentCompactHappy3,
    agentCompactError,
    agentNdjsonHappyEnd,
    agentNdjsonErrorEnd,
    cleanup: () => {
      for (const d of [
        dir,
        auxDir,
        waitDir,
        listDir,
        listRegistryOnlyDir,
        regStateDir,
        regRegistryDir,
        aWatchDir,
      ]) {
        rmSync(d, { recursive: true, force: true });
      }
    },
  };
}

// Built once and shared across every per-catalog test below: the fixtures
// are pure real output, read-only from every deriver's point of view, and
// rebuilding a fresh detector+wait+list+registry environment per catalog
// would be needless (and slow) duplication of the same real invocations.
let fixturesPromise;
function sharedFixtures() {
  fixturesPromise ??= buildFixtures();
  return fixturesPromise;
}

const COVERAGE = {
  REPORT_FIELDS: (f) => Object.keys(f.tick2.report),
  REPORT_RESULT_FIELDS: (f) =>
    new Set([
      ...Object.keys(f.tick2.report.results[0]),
      ...Object.keys(f.failed.report.results[0]),
    ]),
  DELTA_FIELDS: (f) =>
    new Set([
      ...f.tick2.report.deltas.flatMap((d) => Object.keys(d)),
      ...f.tick3.report.deltas.flatMap((d) => Object.keys(d)),
    ]),
  DELTA_CONTEXT_FIELDS: (f) =>
    new Set([
      ...f.tick2.report.deltas.flatMap((d) => Object.keys(d.context)),
      ...f.tick3.report.deltas.flatMap((d) => Object.keys(d.context)),
    ]),
  DELTA_SUMMARY_FIELDS: (f) => {
    const summarized = f.tick2.report.deltas.find((d) => d.entity === 'pr' && d.to);
    assert.ok(summarized, 'at least one real PR delta must carry an observed to-state');
    return Object.keys(summarized.summary);
  },
  DELTA_DETAIL_FIELDS: (f) => {
    const rows = [...f.tick2.report.deltas, ...f.tick3.report.deltas].flatMap(
      (d) => d.details ?? [],
    );
    assert.ok(rows.length > 0, 'at least one real detail row must exist');
    return new Set(rows.flatMap((row) => Object.keys(row)));
  },
  DELTA_LOG_RECORD_FIELDS: (f) => {
    assert.ok(f.logRecords.length > 0, 'at least one real log record must exist');
    return new Set(f.logRecords.flatMap((r) => Object.keys(r)));
  },
  CURSOR_FILE_FIELDS: (f) => Object.keys(f.realCursorFile),
  READ_REPORT_FIELDS: (f) =>
    new Set([
      ...Object.keys(f.readAdvanced.report),
      ...Object.keys(publishedReport(f.readRetentionWarning)),
    ]),
  READ_CURSOR_FIELDS: (f) => Object.keys(f.readAdvanced.report.cursor),
  COMPACT_REPORT_FIELDS: (f) => Object.keys(f.compact.report),
  COMPACT_BOUNDS_FIELDS: (f) =>
    new Set([...Object.keys(f.compact.report.previous), ...Object.keys(f.compact.report.retained)]),
  RESET_REPORT_FIELDS: (f) => Object.keys(f.reset.report),
  CURSOR_SET_REPORT_FIELDS: (f) => Object.keys(f.cursorSet.report),
  CURSOR_SET_CURSOR_FIELDS: (f) => Object.keys(f.cursorSet.report.cursor),
  // waitFailed's report is NOT this shape: `reason: 'error'` takes runWait's
  // OTHER return branch (the bare pre-flight error shape reused from
  // errorResult, already out of scope for every catalog per REPORT_FIELDS'
  // own comment) -- only the success-path report (waitSuccess, whose real
  // --ignore-authors fail-open warning also proves `warnings` reachable here)
  // is this catalog's shape.
  WAIT_REPORT_FIELDS: (f) => Object.keys(publishedReport(f.waitSuccess)),
  LIST_REPORT_FIELDS: (f) => Object.keys(f.listResult.report),
  LIST_MONITOR_FIELDS: (f) => {
    const monitors = [
      ...f.listResult.report.monitors,
      ...f.listRegistryOnlyResult.report.monitors,
      ...f.registryMonitors,
    ];
    assert.ok(monitors.length > 0, 'at least one real monitor entry must exist');
    return new Set(monitors.flatMap((m) => Object.keys(m)));
  },
  // The registry entry itself is not returned by any CLI command (it is an
  // internal breadcrumb file `list` reads) -- but registerMonitor's own
  // return value (`{path, entry}`) IS the exact object it just wrote to
  // disk, no re-derivation needed. Reading real entries this way (not a
  // hand-picked field-name list run through Object.hasOwn, and not literals
  // for the fields `list` never surfaces as-is) means a field registerMonitor
  // stops emitting disappears from the observed set exactly like a field it
  // never emitted in the first place -- both are real drift, and this guard
  // now cannot tell the two apart from "the catalog is simply wrong", which
  // is the point. registryEntryA alone (status 'ok', scope 'watch-pr',
  // watchDir set) already carries every field the catalog documents; B is
  // included anyway so the union reflects two real, differently-shaped
  // writes rather than one.
  REGISTRY_ENTRY_FIELDS: (f) =>
    new Set([...Object.keys(f.registryEntryA), ...Object.keys(f.registryEntryB)]),
  AGENT_COMPACT_REPORT_FIELDS: (f) =>
    new Set([...Object.keys(f.agentCompactHappy), ...Object.keys(f.agentCompactError)]),
  AGENT_COMPACT_DELTA_FIELDS: (f) =>
    new Set([
      ...(f.agentCompactHappy.deltas ?? []).flatMap((d) => Object.keys(d)),
      ...(f.agentCompactHappy3.deltas ?? []).flatMap((d) => Object.keys(d)),
      ...(f.agentCompactError.deltas ?? []).flatMap((d) => Object.keys(d)),
    ]),
  AGENT_NDJSON_END_FIELDS: (f) =>
    new Set([...Object.keys(f.agentNdjsonHappyEnd), ...Object.keys(f.agentNdjsonErrorEnd)]),
};

test('every discovered field catalog has real-output coverage in this guard', () => {
  assert.deepEqual(DISCOVERED_CATALOGS, Object.keys(COVERAGE).sort());
});

// AGENT_* catalogs already have an equivalent unit-level real-output guard
// in test/compact-output.test.mjs; here they are checked the same way as
// every other catalog, driven by the SAME real tick2/failed reports through
// the real compactReport/ndjsonReport functions (see buildFixtures above).
for (const name of DISCOVERED_CATALOGS) {
  test(`${name} matches real emitted output`, async () => {
    const fixtures = await sharedFixtures();
    const observed = COVERAGE[name](fixtures);
    assert.deepEqual([...observed].sort(), [...contract[name]].sort());
  });
}

after(async () => {
  if (fixturesPromise) (await fixturesPromise).cleanup();
});
