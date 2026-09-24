// Shared CLI help metadata and renderers for human and machine-readable output.
import {
  DELTA_DETAIL_FIELDS,
  DELTA_DETAIL_FIELDS_BY_CLASS,
  DELTA_FIELDS,
  DELTA_SUMMARY_ENUMS,
  DELTA_SUMMARY_FIELDS,
  CURSOR_FILE_FIELDS,
  CURSOR_SET_CURSOR_FIELDS,
  CURSOR_SET_REPORT_FIELDS,
  DELTA_LOG_RECORD_FIELDS,
  LIST_MONITOR_FIELDS,
  LIST_REPORT_FIELDS,
  READ_CURSOR_FIELDS,
  COMPACT_REPORT_FIELDS,
  COMPACT_BOUNDS_FIELDS,
  READ_REPORT_FIELDS,
  WAIT_REPORT_FIELDS,
  REPORT_FIELDS,
  RESET_REPORT_FIELDS,
} from './contract.mjs';
import { getPackageMetadata } from './version.mjs';

export const HELP_SCHEMA_VERSION = 1;
const PACKAGE_METADATA = getPackageMetadata();

const OPTION_REPO = {
  name: '--repo',
  valueName: 'owner/name[,owner/name]',
  type: 'string',
  required: false,
  description:
    'GitHub repository in owner/name form. May be comma-separated or repeated; two or more explicit repositories run serially and return one aggregate report. Optional when selecting one repo: when omitted, derived from the current directory’s git remote (origin, then upstream; github.com only) with a `gh repo view` fallback for GitHub Enterprise and SSH-config host aliases. When origin and upstream differ, origin is used and a warning names the other; pass --repo to choose explicitly.',
};

const OPTION_REQUIRED_REPO = {
  name: '--repo',
  valueName: 'owner/name',
  type: 'string',
  required: true,
  description: 'GitHub repository in owner/name form for the producer identity.',
};

const OPTION_MONITOR_ID = {
  name: '--monitor-id',
  valueName: 'id',
  type: 'string',
  required: false,
  description:
    'Stable monitor identity used in reports, event IDs, and derived snapshot paths. Optional: defaults to host- plus a hash of hostname and git worktree (or cwd outside git). GH_DELTA_MONITOR_ID supplies an environment default; --monitor-id wins. Pass an explicit id for durable automation.',
};

const OPTION_STATE_FILE = {
  name: '--state-file',
  valueName: 'path',
  type: 'string',
  required: false,
  description:
    'Explicit snapshot JSON path. Mutually exclusive with --state-dir. Optional: without either flag, a monitor-scoped file under <system temp dir>/gh-delta-<user>/ is used (per-user 0700, ephemeral — reboots or tmp cleanup silently re-seed the baseline).',
};

const OPTION_STATE_DIR = {
  name: '--state-dir',
  valueName: 'dir',
  type: 'string',
  required: false,
  description:
    'Directory for a derived snapshot path scoped by repo, monitor id, and selected entities. Mutually exclusive with --state-file. Optional: see --state-file for the temp-dir default.',
};

const OPTION_ENTITIES = {
  name: '--entities',
  valueName: 'pr,issue',
  type: 'string',
  required: false,
  default: 'pr,issue',
  allowedValues: ['pr', 'issue', 'pr,issue'],
  grammar: 'comma-separated unique values from: pr, issue; input order is canonicalized',
  description: 'Comma-separated entity list: pr, issue, or pr,issue.',
};

const OPTION_FORMAT = {
  name: '--format',
  valueName: 'json|text',
  type: 'string',
  required: false,
  default: 'json',
  allowedValues: ['json', 'text'],
  description: 'Output format: json for programs, text for operators and scheduled logs.',
};
const OPTION_DETECTOR_FORMAT = {
  ...OPTION_FORMAT,
  valueName: 'json|text|compact|ndjson',
  allowedValues: ['json', 'text', 'compact', 'ndjson'],
  description:
    'Output format: legacy json/text, or agent-oriented compact JSON / line-oriented NDJSON.',
};

const OPTION_OUTPOST_URL = {
  name: '--outpost-url',
  valueName: 'url',
  type: 'string',
  required: false,
  description: 'Send one fire-and-forget HTTP POST per delta when exit code is 10.',
};

const OPTION_ENRICH = {
  name: '--enrich',
  valueName: 'review,comments,threads,body,thread-replies',
  type: 'string',
  required: false,
  grammar:
    'comma-separated unique values from: review, comments, threads, body, thread-replies; input order is canonicalized',
  description:
    "After a successful snapshot write only, fetch bodies for matching emitted deltas: review-changed (review), new-comments (comments), unresolved-threads-added (threads), new/first-seen/reopened/baseline-state (body -- one nodes() call per delta for the item's own body, attached as enrichment.body = { body, mentions }; never called for a plain updated), or review-comments-added (thread-replies -- one aliased per-thread GraphQL call per delta, each thread's own comments(last: N) where N is that thread's reply-count increment). Off by default; failures are warnings and never change detection state. Exception: when --ignore-authors and --enrich thread-replies are both set, thread-replies is additionally fetched once, pre-publish, scoped to filtering only (never populates delta.enrichment before publication) -- the one case where opt-in enrichment quota is spent before the snapshot/log write; see --ignore-authors.",
};

const OPTION_OUTPOST_SECRET = {
  name: '--outpost-secret',
  valueName: 'ENV_VARIABLE_NAME',
  type: 'string',
  required: false,
  grammar: 'environment variable name matching [A-Za-z_][A-Za-z0-9_]*',
  description:
    'Read the outpost HMAC secret from this environment variable and sign each POST body. Requires --outpost-url; the argument is a variable name, never the secret value.',
};

const OPTION_OUTPOST_TIMEOUT_MS = {
  name: '--outpost-timeout-ms',
  valueName: 'ms',
  type: 'string',
  required: false,
  default: '4000',
  description: 'Timeout per outpost HTTP POST in milliseconds.',
};

const OPTION_OUTPOST_MAX_POSTS = {
  name: '--outpost-max-posts',
  valueName: 'n',
  type: 'string',
  required: false,
  description: 'Cap outpost POST count per run; omit for unlimited.',
};

const OPTION_GH_TIMEOUT_MS = {
  name: '--gh-timeout-ms',
  valueName: 'ms',
  type: 'string',
  required: false,
  default: '60000',
  description: 'Timeout for each GitHub API subprocess call in milliseconds.',
};

const OPTION_RATE_LIMIT_FLOOR = {
  name: '--rate-limit-floor',
  valueName: 'n',
  type: 'string',
  required: false,
  grammar: 'non-negative safe integer',
  description:
    'Before fetching an observation, require at least n GraphQL rate-limit points. Off by default; a lower remaining quota exits transiently with resetAt and leaves the snapshot unchanged.',
};

const OPTION_NO_REGISTRY = {
  name: '--no-registry',
  type: 'boolean',
  required: false,
  description:
    'Skip the best-effort run-registry breadcrumb this run would otherwise leave for gh-delta list. Equivalent to setting GH_DELTA_NO_REGISTRY=1.',
};

const OPTION_LOCK_STALE_MS = {
  name: '--lock-stale-ms',
  valueName: 'duration',
  type: 'string',
  required: false,
  default: '10m',
  grammar: 'positive integer followed by one unit: s, m, h, d',
  description:
    'Ceiling age for an unreadable/corrupt state-file lock (a kill mid-write can truncate it) before it is presumed abandoned and stolen, with a warning. Does not apply to a readable lock with a future expiresAt -- that one is only stolen once expired. Deleting a stale .lock file by hand is always safe.',
};

const OPTION_LOG = {
  name: '--log',
  type: 'boolean',
  required: false,
  description:
    'Append each emitted post-filter delta to its monitor-scoped durable NDJSON log and fsync it before publishing the snapshot. Off by default; without it no log is opened.',
};

const HELP_OPTIONS = [
  {
    name: '--help',
    type: 'boolean',
    required: false,
    description: 'Show human-readable help.',
  },
  {
    name: '--help-json',
    type: 'boolean',
    required: false,
    description: 'Print this machine-readable help document as JSON.',
  },
  {
    name: '--version',
    type: 'boolean',
    required: false,
    description: 'Print version, distribution channel, and release URL.',
  },
];

const EXIT_CODES = [
  { code: 0, meaning: 'Baseline established or no deltas.' },
  { code: 10, meaning: 'Deltas found.' },
  {
    code: 1,
    meaning:
      'Transient error: GitHub CLI, network, timeout, snapshot write, or state-file lock busy. Retry next tick; snapshot not updated.',
  },
  {
    code: 2,
    meaning:
      'Permanent error: invalid arguments/configuration or unreadable snapshot. Fix before retrying; snapshot not updated.',
  },
];

const HELP_SPECS = {
  'gh-delta': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta',
    version: PACKAGE_METADATA.version,
    summary: 'Deterministic GitHub issue and pull request delta detector.',
    usage:
      'gh-delta [--repo <owner/name>] [--monitor-id <id>] [--state-file <path> | --state-dir <dir>] [--entities pr,issue] [--format json|text|compact|ndjson] [--summary-line] [--detail] [--summaries] [--enrich review,comments,threads,body,thread-replies] [--only-classes <classes>] [--ignore-classes <classes>] [--ignore-authors <logins>] [--settled] [--baseline-emit-state] [--log] [--outpost-url <url>] [--outpost-secret <ENV_VARIABLE_NAME>] [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>] [--gh-timeout-ms <ms>] [--rate-limit-floor <n>] [--no-registry] [--lock-stale-ms <duration>]',
    purpose:
      'Run one deterministic detection pass, update the snapshot after a successful fetch, print legacy JSON/text or agent compact/NDJSON, and exit. Scheduling belongs to the caller.',
    subcommands: [
      {
        name: 'list',
        usage: 'gh-delta list [--state-dir <dir>] [--since <duration>] [--format json|text]',
        summary:
          'Read-only inventory of every monitor that has run on this machine. See gh-delta list --help.',
      },
      {
        name: 'read',
        usage:
          'gh-delta read --cursor <path> [--only-classes <classes>] [--number <positive integer>] [--advance] [--format json|text]',
        summary:
          'Replay a cursor-bound delta log without contacting GitHub. See gh-delta read --help.',
      },
      {
        name: 'cursor set',
        usage: 'gh-delta cursor set <cursor-path> <seq> [--log-file <path>] [--format json|text]',
        summary: 'Initialize or replay a consumer cursor. See gh-delta cursor set --help.',
      },
      {
        name: 'schema',
        usage: 'gh-delta schema [--format json|compact|ndjson]',
        summary: 'Print a local generated JSON Schema for an output format.',
      },
      {
        name: 'status',
        usage: 'gh-delta status [--number <numbers>] [--watch-dir <path>] [--refresh]',
        summary: 'Read current snapshot summaries; --refresh performs one tick first.',
      },
      {
        name: 'wait',
        usage:
          'gh-delta wait --timeout <duration> [--until <classes>] [--until-summary <field=value[,value...]>] [detector options]',
        summary:
          'Bounded worker polling with an optional local-log consumer mode. See gh-delta wait --help.',
      },
    ],
    options: [
      OPTION_REPO,
      OPTION_MONITOR_ID,
      OPTION_STATE_FILE,
      OPTION_STATE_DIR,
      {
        name: '--watch-dir',
        valueName: 'path',
        type: 'string',
        required: false,
        description:
          'Local watch-list directory. When --entities includes pr and the list has 0-10 PR-only entries, automatically makes one targeted GraphQL request (zero for empty) and uses a separate watch snapshot; issue entries, >10 entries, or --entities issue retain broad fetching. Mutually exclusive with --number.',
      },
      {
        name: '--number',
        valueName: 'numbers',
        type: 'string',
        required: false,
        description: 'Ephemeral comma-separated positive-number post-fetch selector.',
      },
      OPTION_ENTITIES,
      OPTION_DETECTOR_FORMAT,
      {
        name: '--summary-line',
        type: 'boolean',
        required: false,
        description: 'Add a human-readable summaryLine field to each JSON delta.',
      },
      {
        name: '--detail',
        type: 'boolean',
        required: false,
        description: 'Add structured details per delta, plus summaryLine.',
      },
      {
        name: '--summaries',
        type: 'boolean',
        required: false,
        description:
          'Deprecated no-op: delta.summary is always present now (ciRollup, reviewDecision, mergeable, mergeStateStatus, state, isDraft, unresolvedReviewThreads, headSha, failedChecks for a PR; state only for an issue). Kept accepted so existing scripts passing it are unaffected.',
      },
      {
        name: '--full',
        type: 'boolean',
        required: false,
        description:
          'Include the full from/to fingerprints in compact/ndjson output. Always present in --format json; omitted in compact/ndjson unless this flag is set.',
      },
      OPTION_ENRICH,
      {
        name: '--only-classes',
        valueName: 'classes',
        type: 'string',
        required: false,
        grammar:
          'comma-separated one or more DELTA_CLASSES values; whitespace and duplicates are ignored',
        description:
          'Attention filter: keep a delta when it carries at least one named class. Unknown classes are config errors. Apply before --ignore-classes.',
      },
      {
        name: '--ignore-classes',
        valueName: 'classes',
        type: 'string',
        required: false,
        grammar:
          'comma-separated one or more DELTA_CLASSES values; whitespace and duplicates are ignored',
        description:
          'Attention filter: remove named classes from each delta, dropping a delta left with no classes. Unknown classes are config errors; this is the final class veto.',
      },
      {
        name: '--ignore-authors',
        valueName: 'logins',
        type: 'string',
        required: false,
        grammar:
          'comma-separated non-empty GitHub logins; whitespace trimmed, comparison case-insensitive, duplicates ignored',
        description:
          'Attention filter: suppress new-comments when every newly inferred bounded conversation comment has a listed author, suppress review-changed when every newly inferred review author is listed, and suppress review-comments-added when every reply across its incremented threads has a listed author. Fails open silently (as before) whenever conversation or review lacks the identity it needs to check: conversation, if the five-row window is incomplete or an author/id is missing; reviews, if a changed review lacks an attributable row. Thread replies are the one source that warns explicitly when it cannot verify -- either because --enrich thread-replies is not also set, or because a brand-new thread only partly (or not at all) explains the observed reviewComments rise -- unless the double opt-in supplies full author coverage, via one pre-publish, filter-scoped thread-replies call: the sole exception to opt-in enrichment quota being spent only after publication.',
      },
      {
        name: '--settled',
        type: 'boolean',
        required: false,
        description:
          'Attention filter: drop a delta whose summary has ciRollup pending or mergeable unknown. Implies --summaries; ciRollup none is settled.',
      },
      {
        name: '--baseline-emit-state',
        type: 'boolean',
        required: false,
        description:
          'On the run that seeds a baseline, also emit one synthetic baseline-state delta per tracked OPEN item (from: null, to: the observed fingerprint) so pre-existing trouble (already conflicting, already CI-blocked) is visible instead of silent until the next change. Off by default; the run then exits 10 with baseline: true and a non-empty deltas array. Ids are content-addressed and stable across re-baselining. Do NOT treat baseline-state as newly created.',
      },
      OPTION_LOG,
      OPTION_OUTPOST_URL,
      OPTION_OUTPOST_SECRET,
      OPTION_OUTPOST_TIMEOUT_MS,
      OPTION_OUTPOST_MAX_POSTS,
      OPTION_GH_TIMEOUT_MS,
      OPTION_RATE_LIMIT_FLOOR,
      OPTION_NO_REGISTRY,
      OPTION_LOCK_STALE_MS,
      {
        name: '--stale-after',
        valueName: 'duration',
        type: 'string',
        required: false,
        description:
          'Emit one stale delta per UTC day of inactivity after this shared-duration threshold.',
      },
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text', 'compact', 'ndjson'],
      stream: 'stdout',
      schema: 'detector-report-v1',
      reportFields: REPORT_FIELDS,
      deltaFields: DELTA_FIELDS,
      deltaDetailFields: DELTA_DETAIL_FIELDS,
      deltaDetailFieldsByClass: DELTA_DETAIL_FIELDS_BY_CLASS,
      deltaSummaryFields: DELTA_SUMMARY_FIELDS,
      deltaSummaryEnums: DELTA_SUMMARY_ENUMS,
      description:
        "JSON output contains schemaVersion, detectedAt, monitorId, entities, repos (always an array, one entry even for a single repository), results, deltas, filteredDeltas (always present, 0 when no attention filter ran), warnings (always present, possibly empty), and summary fields. results is one row per repo in the tick: {repo, baseline, repoSource ('flag' | 'git-remote' | 'gh', how --repo was resolved), stateFile, logFile (only with --log), rateLimit ({cost, remaining, resetAt} accumulated across every GraphQL call this tick, or null if none was made), error (only on a per-repo failure: {kind, message, hint, resetAt?})}; there is no top-level errors field -- a partial multi-repo failure is visible only in its own results[] entry. Every delta carries a stable content-addressed delta.id (64-char sha256 hex of repo, entity, number, and the observed to-state; from+classes+missingTicks when to is null) for idempotent dedupe; it excludes monitorId, so the same observed change from any monitor yields the same id. delta.repo is always present. delta.context carries identity/display fields never compared and never hashed into delta.id: id, title (null on the missing lifecycle -- to === null -- since the current title cannot be confirmed without a successful fetch), url, author (null for a deleted/ghost account), createdAt, and headRefName (PR-only, retained by GitHub even after the branch is deleted). delta.changed is always present: a bounded, capped diff of the fingerprint fields that moved (see the compact/ndjson section below for its shape). delta.summary is always present: for a PR with an observed to-state, ciRollup (green|failed|pending|none; a PR with zero checks is none, never green), reviewDecision (approved|changes_requested|review_required|none; none also covers \"no review-required rule\" and \"required but none submitted yet\", which GitHub does not distinguish here), mergeable (mergeable|conflicting|unknown; unknown means GitHub has not finished recomputing), mergeStateStatus (behind|blocked|clean|dirty|draft|has_hooks|unstable|unknown; the same observation's mergeStateStatus, where unknown means not reported/absent — fail-closed, treated like mergeable: unknown, so a PR that is mergeable yet behind its base or blocked by a protection rule is not mistaken for ready), state (open|closed|merged), isDraft (boolean), unresolvedReviewThreads (integer), headSha (the head commit SHA), and failedChecks (the failing subset of the same to.checks rollup, as {name, runId, jobId, detailsUrl}; runId/jobId are present only when detailsUrl parsed as a github.com Actions run/job URL and are omitted, never null, otherwise -- GitHub Enterprise checks carry detailsUrl only, since gh-delta's repo identity never carries a host to anchor the pattern to); for an issue with an observed to-state, only state; for the missing lifecycle (to === null), null. See output.deltaSummaryFields and output.deltaSummaryEnums for the exact field set and enum domains. delta.from/delta.to (the raw compared fingerprints) are always present in --format json; --summaries is now a deprecated no-op (kept accepted, does nothing) since summary is unconditional. --summary-line adds delta.summaryLine, and --detail adds delta.details. --enrich optionally adds transient delta.enrichment after snapshot publication; it is never written to snapshots or durable logs, failures are warnings, and matching outpost payloads mirror it. ci-changed and review-changed details name the exact checks/reviews that changed (added, removed, changed) when both fingerprint sides carry the persisted normalized summaries; opaque: true marks a digest transition the detail cannot name (e.g. a snapshot written before summaries were persisted). relabeled, assignees-changed, and review-requests-changed details carry added/removed arrays of names (teams as org/slug). The opaque fingerprints and the rest of the delta shape are byte-identical regardless of --summaries. Error output for a pre-flight failure (raised before any repo is known, e.g. bad flags) is the unenveloped schemaVersion, error, kind, at, and optional repo and monitorId; resetAt is present only for a rate-limit floor error. A failure discovered after the repo is known instead surfaces only inside its results[] entry, per above. Text output contains an operator heartbeat and suggested actions.",
    },
    exitCodes: EXIT_CODES,
    safety: [
      'Snapshot writes are atomic.',
      'The snapshot is not updated on GitHub CLI, network, parse, or argument errors.',
      'Outpost delivery warnings do not change the detector exit code.',
      'Each successful run leaves a best-effort registry breadcrumb for gh-delta list; a registry write failure is silent and never changes the result. Disable with --no-registry or GH_DELTA_NO_REGISTRY=1.',
      'A state-file lock (<stateFile>.lock) enforces one writer per (repo, monitorId, entities): a second run against the same state file exits 1 with kind busy instead of silently losing an update. Deleting a .lock file by hand is always safe.',
    ],
    stateConcurrency: {
      sameStateFile: 'locked: one writer at a time, others exit busy (1)',
      overlapRisk:
        'the pre-write fence narrows, but cannot fully close, a lost-update window to a scheduler gap between the fence check and the snapshot rename',
      corruptionRisk: 'atomic writes prevent partial JSON snapshots',
    },
    examples: [
      {
        description: 'Seed or check a repository snapshot.',
        command: 'gh-delta --repo owner/repo --monitor-id prs --state-dir .gh-delta --entities pr',
      },
      {
        description: 'Run a scheduled monitor tick with readable logs.',
        command:
          'gh-delta --repo owner/repo --monitor-id prs --state-dir .gh-delta --entities pr --format text',
      },
      {
        description: 'Print machine-readable help for agents and tooling.',
        command: 'gh-delta --help-json',
      },
      {
        description: 'Print the package version.',
        command: 'gh-delta --version',
      },
    ],
  },
  'gh-delta list': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta list',
    version: PACKAGE_METADATA.version,
    summary: 'Read-only inventory of every local gh-delta monitor.',
    usage: 'gh-delta list [--state-dir <dir>] [--since <duration>] [--format json|text]',
    purpose:
      'List the monitors that have run on this machine: repo, monitor id, entities, last run, and stored object counts. Without --state-dir the inventory is global — the run registry (which every successful run feeds unless opted out) merged with a scan of the temp-dir default location — so monitors using any --state-dir or --state-file appear. An explicit --state-dir narrows the inventory to a scan of that directory (derived filenames plus self-describing snapshot meta). Read-only: never contacts GitHub and never creates, updates, or deletes snapshots or registry entries.',
    options: [
      {
        name: '--state-dir',
        valueName: 'dir',
        type: 'string',
        required: false,
        description:
          'Narrow the inventory to a scan of this directory only, skipping the run registry. Optional: without it, the registry plus the per-user temp default location are inventoried.',
      },
      {
        name: '--since',
        valueName: 'duration',
        type: 'string',
        required: false,
        grammar: 'positive integer followed by one unit: s, m, h, d',
        description:
          'Only list monitors whose last run is within this window (e.g. 90s, 15m, 24h, 7d). Optional: without it, every monitor snapshot is listed.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'list-report-v1',
      reportFields: LIST_REPORT_FIELDS,
      monitorFields: LIST_MONITOR_FIELDS,
      description:
        'JSON output contains schemaVersion, command ("list"), stateDir, registryDir (the run-registry directory consulted, or null when --state-dir narrowed the inventory), since (the echoed --since value or null), at, monitors, skippedFiles, and summary. Each monitor entry carries repo, monitorId, entities, stateFile, lastRun (snapshot meta.horizon when readable; registry lastRun or file mtime otherwise), schemaVersion (the snapshot\'s meta.schemaVersion when the snapshot is readable, null otherwise -- a monitor stuck on a pre-schema-v2 snapshot needs `gh-delta reset`), and prCount/issueCount (null with an error string when the snapshot is corrupt, or with stale: true when a registered snapshot file no longer exists). Economical PR-watch snapshots additionally carry scope: "watch-pr". Entries are sorted by lastRun, newest first. skippedFiles counts directory entries that could not be identified as monitor snapshots or registry entries. summary is human-readable only; do not parse it.',
    },
    exitCodes: [
      { code: 0, meaning: 'Inventory produced (possibly empty).' },
      { code: 1, meaning: 'Transient error: state directory unreadable.' },
      { code: 2, meaning: 'Permanent error: invalid arguments.' },
    ],
    safety: [
      'list never contacts GitHub.',
      'list never creates, updates, or deletes snapshots or registry entries; it is safe to run while monitors tick.',
      'A corrupt snapshot is reported as an entry with an error field, not a process failure.',
      'A registered monitor whose snapshot file is gone is reported with stale: true, not hidden. Deleting the registry directory is always safe; it rebuilds as monitors run.',
    ],
    examples: [
      {
        description:
          'Global inventory: every monitor this machine has run (registry + temp default).',
        command: 'gh-delta list',
      },
      {
        description: 'Monitors that ran in the last 24 hours, as operator text.',
        command: 'gh-delta list --since 24h --format text',
      },
      {
        description: 'Narrow to one shared state directory (scan only, no registry).',
        command: 'gh-delta list --state-dir .gh-delta',
      },
    ],
  },
  'gh-delta read': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta read',
    version: PACKAGE_METADATA.version,
    summary: 'Read complete delta-log records after a consumer cursor.',
    usage:
      'gh-delta read --cursor <path> [--only-classes <classes>] [--number <positive integer>] [--advance] [--format json|text]',
    purpose:
      'Read the cursor-bound log only. Never contacts GitHub or changes a snapshot; --advance serializes one cursor through its local lock before atomically moving it to the complete tail scanned.',
    options: [
      {
        name: '--cursor',
        valueName: 'path',
        type: 'string',
        required: true,
        description: 'Existing cursor JSON file bound to one absolute delta log path.',
      },
      {
        name: '--only-classes',
        valueName: 'classes',
        type: 'string',
        required: false,
        grammar: 'comma-separated one or more DELTA_CLASSES values',
        description: 'Keep a record when its delta has at least one named class.',
      },
      {
        name: '--number',
        valueName: 'positive integer',
        type: 'string',
        required: false,
        description:
          'Keep only deltas for this GitHub issue or pull-request number; this is not a result limit.',
      },
      {
        name: '--advance',
        type: 'boolean',
        required: false,
        description:
          'Serialize this cursor, then atomically store the complete log tail scanned; rejected records are also advanced past. A concurrent mutator exits busy.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'read-report-v1',
      reportFields: READ_REPORT_FIELDS,
      cursorFields: READ_CURSOR_FIELDS,
      deltaFields: DELTA_FIELDS,
      logRecordFields: DELTA_LOG_RECORD_FIELDS,
      cursorFileFields: CURSOR_FILE_FIELDS,
      description:
        'Exit 10 when deltas is nonempty; cursor.to is always the complete tail scanned, including records rejected by consumer filters. A partial final line is ignored.',
    },
    exitCodes: [
      { code: 0, meaning: 'No matching deltas.' },
      { code: 10, meaning: 'Matching deltas returned.' },
      { code: 1, meaning: 'Transient filesystem error.' },
      { code: 2, meaning: 'Invalid arguments, cursor, or complete log record.' },
    ],
  },
  'gh-delta wait': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta wait',
    version: PACKAGE_METADATA.version,
    summary: 'Wait for a future delta or current PR summary condition.',
    usage:
      'gh-delta wait --timeout <duration> [--until <classes>] [--until-summary <field=value[,value...]>] [--interval <duration>] [--heartbeat-file <path>] [--progress] [--from-log --cursor <path>] [detector options]',
    purpose:
      'Runs bounded detector ticks, releasing the state lock before every sleep. --until waits for future delta classes; --until-summary also tests the first observed state.',
    options: [
      {
        name: '--timeout',
        valueName: 'duration',
        type: 'string',
        required: true,
        description: 'Maximum total wait; uses the shared positive duration grammar.',
      },
      {
        name: '--until',
        valueName: 'classes',
        type: 'string',
        required: false,
        description: 'Comma-separated delta classes that satisfy a future emitted delta.',
      },
      {
        name: '--until-summary',
        valueName: 'field=value[,value...]',
        type: 'string',
        required: false,
        description:
          'Current PR summary condition; comma-separated values are alternatives and are evaluated on the first iteration.',
      },
      {
        name: '--interval',
        valueName: 'duration',
        type: 'string',
        required: false,
        default: '60s',
        description: 'Initial delay between iterations.',
      },
      {
        name: '--max-interval',
        valueName: 'duration',
        type: 'string',
        required: false,
        description: 'Optional cap for backoff delays.',
      },
      {
        name: '--backoff',
        valueName: 'positive number',
        type: 'string',
        required: false,
        default: '1',
        description: 'Multiply the next delay after an unmatched iteration.',
      },
      {
        name: '--settle',
        valueName: 'duration',
        type: 'string',
        required: false,
        description: 'Delay final delivery after a matching future delta.',
      },
      {
        name: '--heartbeat-file',
        valueName: 'path',
        type: 'string',
        required: false,
        description: 'Runtime heartbeat file; defaults to <stateFile>.hb.',
      },
      {
        name: '--progress',
        type: 'boolean',
        required: false,
        description: 'Write one NDJSON tick record to stderr per completed iteration.',
      },
      {
        name: '--from-log',
        type: 'boolean',
        required: false,
        description: 'Consume the local durable delta log through --cursor; never contacts GitHub.',
      },
      {
        name: '--cursor',
        valueName: 'path',
        type: 'string',
        required: false,
        description: 'Required cursor binding when --from-log is selected.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json'],
      stream: 'stdout',
      schema: 'wait-report-v1',
      reportFields: WAIT_REPORT_FIELDS,
    },
    exitCodes: [
      { code: 0, meaning: 'Timeout or SIGTERM after the current iteration.' },
      { code: 10, meaning: 'A requested class or summary condition was satisfied.' },
      { code: 1, meaning: 'Transient detector or filesystem failure.' },
      { code: 2, meaning: 'Invalid arguments or permanent detector failure.' },
    ],
  },
  'gh-delta cursor set': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta cursor set',
    version: PACKAGE_METADATA.version,
    summary: 'Atomically initialize, advance, or replay a consumer cursor.',
    usage: 'gh-delta cursor set <cursor-path> <seq> [--log-file <path>] [--format json|text]',
    purpose:
      'Serialize this cursor and set a non-negative sequence. A missing cursor requires --log-file; an existing cursor remains bound to its original log.',
    options: [
      {
        name: '--log-file',
        valueName: 'path',
        type: 'string',
        required: false,
        description:
          'Absolute or relative log path; normalized to absolute. Required only to initialize a missing cursor.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'cursor-set-report-v1',
      reportFields: CURSOR_SET_REPORT_FIELDS,
      cursorFields: CURSOR_SET_CURSOR_FIELDS,
      cursorFileFields: CURSOR_FILE_FIELDS,
      description:
        'A sequence above the complete log tail is rejected. Setting a lower sequence is explicit replay.',
    },
    exitCodes: [
      { code: 0, meaning: 'Cursor replaced atomically.' },
      { code: 1, meaning: 'Transient filesystem error.' },
      { code: 2, meaning: 'Invalid arguments, cursor, or complete log record.' },
    ],
  },
  'gh-delta log compact': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta log compact',
    version: PACKAGE_METADATA.version,
    summary: 'Compact one producer-derived durable delta log.',
    usage:
      'gh-delta log compact --repo <owner/name> --monitor-id <id> (--state-file <path>|--state-dir <dir>) --keep <duration|positive-count> [--entities pr,issue] [--format json|text]',
    purpose:
      'Local-only retention. Takes the producer state-file lock and never changes snapshots or cursors.',
    options: [
      OPTION_REQUIRED_REPO,
      OPTION_MONITOR_ID,
      OPTION_ENTITIES,
      OPTION_STATE_FILE,
      OPTION_STATE_DIR,
      {
        name: '--keep',
        valueName: 'duration|positive-count',
        type: 'string',
        required: true,
        description: 'Keep newest count records or records detected in the duration window.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'compact-report-v1',
      reportFields: COMPACT_REPORT_FIELDS,
      boundsFields: COMPACT_BOUNDS_FIELDS,
      description: 'Reports prior and retained sequence bounds and counts.',
    },
    exitCodes: [
      { code: 0, meaning: 'Log compacted.' },
      { code: 1, meaning: 'Filesystem or lock-busy error.' },
      { code: 2, meaning: 'Invalid arguments or log.' },
    ],
  },
  'gh-delta reset': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta reset',
    version: PACKAGE_METADATA.version,
    summary: "Delete one monitor's snapshot and durable log to start a clean baseline.",
    usage:
      'gh-delta reset --repo <owner/name> --monitor-id <id> (--state-file <path>|--state-dir <dir>) --yes [--entities pr,issue] [--format json|text]',
    purpose:
      "Re-baseline a monitor stuck on an unreadable or pre-schema-v2 snapshot/log (closes the historical `doctor`/`reset` gap -- see gh-delta doctor). Takes the monitor's state-file lock for the whole operation and releases it last, so a concurrent tick blocked on the same lock can never observe a half-deleted monitor: it either runs against the fully intact pre-reset state, or against the fully clean post-reset state. Deletes the snapshot file, the log's published manifest, and the log's physical data file. --yes is required; without it, reset is refused before the lock is even acquired. A monitor with nothing on disk resets successfully as a no-op.",
    options: [
      OPTION_REQUIRED_REPO,
      OPTION_MONITOR_ID,
      OPTION_ENTITIES,
      OPTION_STATE_FILE,
      OPTION_STATE_DIR,
      {
        name: '--yes',
        type: 'boolean',
        required: true,
        description: 'Confirm the deletion. Without it, reset is refused before locking anything.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'reset-report-v1',
      reportFields: RESET_REPORT_FIELDS,
      description:
        'Reports the deleted stateFile and logFile paths. An external consumer cursor bound to the deleted log now points past its tail (seq > 0 against a fresh, empty log): `gh-delta read`/`cursor set` reject it with kind log naming the cursor seq and the tail, rather than silently restarting delivery from the new firstSeq, which would re-deliver history the consumer already believes consumed. Delete the stale cursor file to resume.',
    },
    exitCodes: [
      { code: 0, meaning: 'Reset completed (including a no-op reset of a clean monitor).' },
      { code: 1, meaning: 'Filesystem or lock-busy error.' },
      { code: 2, meaning: 'Invalid arguments, or --yes was not passed.' },
    ],
    safety: [
      'Irreversible: the snapshot and durable log are deleted, not archived.',
      'The monitor lock is held for the whole deletion and released last, so a concurrent tick cannot interleave with a half-deleted monitor.',
    ],
  },
  ...Object.fromEntries(
    ['add', 'rm', 'ls'].map((action) => [
      `gh-delta watch ${action}`,
      {
        helpSchemaVersion: HELP_SCHEMA_VERSION,
        command: `gh-delta watch ${action}`,
        version: PACKAGE_METADATA.version,
        summary: `Manage local watch entries (${action}).`,
        usage: `gh-delta watch ${action}${action === 'ls' ? '' : ' pr:42'} [--watch-dir <path>]`,
        purpose: 'Local-only watch-list management; never contacts GitHub or writes a snapshot.',
        options: [
          OPTION_REPO,
          OPTION_MONITOR_ID,
          OPTION_STATE_DIR,
          {
            name: '--watch-dir',
            valueName: 'path',
            type: 'string',
            required: false,
            description: 'Explicit watch directory.',
          },
          ...(action === 'add'
            ? [
                {
                  name: '--until',
                  valueName: 'merged|closed',
                  type: 'string',
                  required: true,
                  description: 'Terminal state that removes the entry after a successful tick.',
                },
              ]
            : []),
          OPTION_FORMAT,
          ...HELP_OPTIONS,
        ],
        exitCodes: [
          { code: 0, meaning: 'Command completed.' },
          { code: 1, meaning: 'Filesystem error.' },
          { code: 2, meaning: 'Invalid arguments or watch entry.' },
        ],
      },
    ]),
  ),
  'gh-delta status': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta status',
    version: PACKAGE_METADATA.version,
    summary: 'Read current open-item summaries from a local snapshot.',
    usage:
      'gh-delta status [--repo <owner/name>] [--number <numbers>] [--watch-dir <path>] [--state-file <path>|--state-dir <dir>] [--refresh] [--format json|text]',
    purpose:
      'Local-only snapshot status; without --refresh it never contacts GitHub and never writes state.',
    options: [
      OPTION_REPO,
      OPTION_MONITOR_ID,
      OPTION_STATE_FILE,
      OPTION_STATE_DIR,
      {
        name: '--watch-dir',
        valueName: 'path',
        type: 'string',
        required: false,
        description:
          'Read the local watch list and use its economical PR snapshot when it is a 0-10 PR-only watch universe.',
      },
      OPTION_ENTITIES,
      {
        name: '--number',
        valueName: 'numbers',
        type: 'string',
        required: false,
        description: 'Comma-separated positive item numbers.',
      },
      {
        name: '--refresh',
        type: 'boolean',
        required: false,
        description:
          'Perform one normal detector tick before the local status read; this is the only status mode that contacts GitHub and writes state, and it preserves existing stale bookkeeping for unchanged items.',
      },
      OPTION_FORMAT,
      ...HELP_OPTIONS,
    ],
    output: { formats: ['json', 'text'], stream: 'stdout', schema: 'status-report-v1' },
    exitCodes: [
      { code: 0, meaning: 'Status produced.' },
      { code: 1, meaning: 'Refresh, local filesystem, or GitHub error.' },
      { code: 2, meaning: 'Invalid arguments, watch entry, or snapshot.' },
    ],
  },
  'gh-delta schema': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta schema',
    version: PACKAGE_METADATA.version,
    summary: 'Print generated JSON Schema for a gh-delta output format.',
    usage: 'gh-delta schema [--format json|compact|ndjson]',
    purpose:
      'Local-only schema generation; performs no repository, filesystem state, or GitHub access.',
    options: [
      {
        name: '--format',
        valueName: 'json|compact|ndjson',
        type: 'string',
        required: false,
        default: 'json',
        allowedValues: ['json', 'compact', 'ndjson'],
        description: 'Schema format to print.',
      },
      ...HELP_OPTIONS,
    ],
    output: { formats: ['json'], stream: 'stdout', schema: 'json-schema-draft-2020-12' },
    exitCodes: [
      { code: 0, meaning: 'Schema printed.' },
      { code: 2, meaning: 'Invalid arguments or format.' },
    ],
  },
};

// A wait iteration accepts the complete detector grammar as well as its loop
// controls. Keep that shared surface in the generated help rather than silently
// accepting detector flags that an agent cannot discover from `wait --help`.
HELP_SPECS['gh-delta wait'].options.push(
  ...HELP_SPECS['gh-delta'].options.filter(
    (option) =>
      ![
        '--format',
        '--help',
        '--help-json',
        '--version',
        '--outpost-url',
        '--outpost-secret',
        '--outpost-timeout-ms',
        '--outpost-max-posts',
      ].includes(option.name),
  ),
);

const DX_HELP_OPTIONS = [
  {
    name: '--format',
    valueName: 'json|text',
    type: 'string',
    required: false,
    default: 'json',
    allowedValues: ['json', 'text'],
    description: 'Output format.',
  },
  ...HELP_OPTIONS,
];

HELP_SPECS['gh-delta init'] = {
  helpSchemaVersion: HELP_SCHEMA_VERSION,
  command: 'gh-delta init',
  version: PACKAGE_METADATA.version,
  summary: 'Create a durable project monitor and establish its baseline.',
  usage:
    'gh-delta init [--repo <owner/name>] [--state-dir <dir>] [--monitor-id <id>] [--entities pr,issue] [--agent]',
  purpose:
    'Safely creates .gh-delta.json only after one normal baseline succeeds. It never overwrites existing project configuration; --agent prints snippets but installs nothing.',
  options: [
    OPTION_REPO,
    OPTION_MONITOR_ID,
    OPTION_STATE_DIR,
    OPTION_ENTITIES,
    {
      name: '--agent',
      type: 'boolean',
      required: false,
      description: 'Include cron, systemd, and agent-prompt snippets without installing them.',
    },
    ...DX_HELP_OPTIONS,
  ],
  output: { formats: ['json', 'text'], stream: 'stdout', schema: 'init-report-v1' },
  exitCodes: [
    { code: 0, meaning: 'Baseline and project configuration created.' },
    { code: 1, meaning: 'Baseline could not fetch GitHub.' },
    { code: 2, meaning: 'Invalid configuration or unsafe existing path.' },
  ],
  safety: [
    'Never overwrites .gh-delta.json.',
    'Never installs cron or systemd units.',
    'Rejects temporary state directories.',
  ],
};
HELP_SPECS['gh-delta doctor'] = {
  helpSchemaVersion: HELP_SCHEMA_VERSION,
  command: 'gh-delta doctor',
  version: PACKAGE_METADATA.version,
  summary: 'Read-only local and GitHub prerequisite diagnosis.',
  usage: 'gh-delta doctor [--repo <owner/name>] [--state-dir <dir>] [--monitor-id <id>]',
  purpose:
    'Checks gh availability/authentication, token scope need, GraphQL quota, state directory, Node version, registry collision, and temporary-state risk. It does not modify GitHub or local monitor state.',
  options: [OPTION_REPO, OPTION_MONITOR_ID, OPTION_STATE_DIR, ...DX_HELP_OPTIONS],
  output: { formats: ['json', 'text'], stream: 'stdout', schema: 'doctor-report-v1' },
  exitCodes: [
    { code: 0, meaning: 'Required checks passed.' },
    { code: 1, meaning: 'One or more required checks failed.' },
    { code: 2, meaning: 'Invalid command configuration.' },
  ],
  safety: [
    'Uses gh auth status without --show-token.',
    'Read-only: never creates, updates, or deletes monitor files.',
  ],
};
HELP_SPECS['gh-delta explain'] = {
  helpSchemaVersion: HELP_SCHEMA_VERSION,
  command: 'gh-delta explain',
  version: PACKAGE_METADATA.version,
  summary: 'Explain a durable delta by its existing fingerprint transition.',
  usage: 'gh-delta explain <delta-id> (--log-file <path> | --report-file <path>)',
  purpose:
    'Reads an explicit local delta log or prior report and applies the same pure diffFingerprint used by agent output. It never contacts GitHub and creates no implicit persistence.',
  options: [
    {
      name: '--log-file',
      valueName: 'path',
      type: 'string',
      required: false,
      description: 'Explicit durable NDJSON delta log.',
    },
    {
      name: '--report-file',
      valueName: 'path',
      type: 'string',
      required: false,
      description: 'Explicit prior JSON detector report.',
    },
    ...DX_HELP_OPTIONS,
  ],
  output: { formats: ['json', 'text'], stream: 'stdout', schema: 'explain-report-v1' },
  exitCodes: [
    { code: 0, meaning: 'Delta found and explained.' },
    { code: 1, meaning: 'Local input could not be read.' },
    { code: 2, meaning: 'Invalid input or delta absent.' },
  ],
  safety: [
    'Local read-only command: no GitHub calls, writes, cursor moves, or hidden last-report storage.',
  ],
};
HELP_SPECS['gh-delta demo'] = {
  helpSchemaVersion: HELP_SCHEMA_VERSION,
  command: 'gh-delta demo',
  version: PACKAGE_METADATA.version,
  summary: 'Print the fixed public demo-repository command.',
  usage: 'gh-delta demo [--format json|text]',
  purpose:
    'Points at diegomarino/gh-delta-demo without creating or modifying that external repository.',
  options: DX_HELP_OPTIONS,
  output: { formats: ['json', 'text'], stream: 'stdout', schema: 'demo-report-v1' },
  exitCodes: [
    { code: 0, meaning: 'Demo command printed.' },
    { code: 2, meaning: 'Invalid command configuration.' },
  ],
  safety: ['Never contacts or mutates the external demo repository.'],
};
HELP_SPECS['gh-delta'].subcommands.push(
  {
    name: 'init',
    usage: 'gh-delta init [--agent]',
    summary: 'Create a durable project monitor and baseline.',
  },
  { name: 'doctor', usage: 'gh-delta doctor', summary: 'Run read-only prerequisite diagnostics.' },
  {
    name: 'explain',
    usage: 'gh-delta explain <delta-id> (--log-file <path> | --report-file <path>)',
    summary: 'Explain an existing local delta.',
  },
  { name: 'demo', usage: 'gh-delta demo', summary: 'Print the fixed public demo command.' },
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Every command key documented in HELP_SPECS, exposed without handing out
// the mutable HELP_SPECS object itself (same clone-on-read discipline as
// getHelpSpec). Used by test/help-options-sync.test.mjs to confirm every
// help-documented command also has a registered parser option table, and
// vice versa.
export const HELP_COMMAND_KEYS = Object.freeze(Object.keys(HELP_SPECS));

/**
 * Build the user-facing option label string.
 *
 * Boolean flags remain bare, while value-taking flags include a placeholder.
 */
function optionLabel(option) {
  return option.valueName ? `${option.name} <${option.valueName}>` : option.name;
}

/**
 * Render an aligned CLI option table for human-readable help output.
 */
function renderOptions(options) {
  const width = Math.max(...options.map((option) => optionLabel(option).length)) + 2;
  return options
    .map((option) => `  ${optionLabel(option).padEnd(width)}${option.description}`)
    .join('\n');
}

/**
 * Render exit code meanings as a plain-text two-column block.
 */
function renderExitCodes(exitCodes) {
  return exitCodes.map((entry) => `  ${String(entry.code).padEnd(3)} ${entry.meaning}`).join('\n');
}

/**
 * Render the subcommand table for commands that have one.
 */
function renderSubcommands(subcommands) {
  const width = Math.max(...subcommands.map((entry) => entry.name.length)) + 2;
  return subcommands.map((entry) => `  ${entry.name.padEnd(width)}${entry.summary}`).join('\n');
}

/**
 * Return structured help metadata for a supported command.
 *
 * Callers receive a copy so consumers can sort or annotate the object without
 * mutating the canonical CLI help used by the renderers.
 */
export function getHelpSpec(command) {
  const spec = HELP_SPECS[command];
  if (!spec) throw new Error(`unknown help command: ${command}`);
  return clone(spec);
}

/**
 * Render the command help intended for humans.
 */
export function renderHelpText(command) {
  const spec = getHelpSpec(command);
  const sections = [
    `Usage:\n  ${spec.usage}`,
    spec.purpose,
    spec.subcommands ? `Subcommands:\n${renderSubcommands(spec.subcommands)}` : null,
    `Options:\n${renderOptions(spec.options)}`,
    `Exit codes:\n${renderExitCodes(spec.exitCodes)}`,
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/**
 * Render the command help intended for LLMs, agents, and other tools.
 */
export function renderHelpJson(command) {
  return `${JSON.stringify(getHelpSpec(command), null, 2)}\n`;
}
