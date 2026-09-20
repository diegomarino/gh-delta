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
  REPORT_FIELDS,
} from './contract.mjs';
import { getPackageMetadata } from './version.mjs';

export const HELP_SCHEMA_VERSION = 1;
const PACKAGE_METADATA = getPackageMetadata();

const OPTION_REPO = {
  name: '--repo',
  valueName: 'owner/name',
  type: 'string',
  required: false,
  description:
    'GitHub repository in owner/name form. Optional: when omitted, derived from the current directory’s git remote (origin, then upstream; github.com only) with a `gh repo view` fallback for GitHub Enterprise and SSH-config host aliases. When origin and upstream differ, origin is used and a warning names the other; pass --repo to choose explicitly.',
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

const OPTION_OUTPOST_URL = {
  name: '--outpost-url',
  valueName: 'url',
  type: 'string',
  required: false,
  description: 'Send one fire-and-forget HTTP POST per delta when exit code is 10.',
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
  description: 'Timeout for each GitHub GraphQL fetch in milliseconds.',
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
    description: 'Print package version.',
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
      'gh-delta [--repo <owner/name>] [--monitor-id <id>] [--state-file <path> | --state-dir <dir>] [--entities pr,issue] [--format json|text] [--summary-line] [--detail] [--summaries] [--only-classes <classes>] [--ignore-classes <classes>] [--ignore-authors <logins>] [--settled] [--baseline-emit-state] [--log] [--outpost-url <url>] [--outpost-secret <ENV_VARIABLE_NAME>] [--outpost-timeout-ms <ms>] [--outpost-max-posts <n>] [--gh-timeout-ms <ms>] [--no-registry] [--lock-stale-ms <duration>]',
    purpose:
      'Run one deterministic detection pass, update the snapshot after a successful fetch, print JSON or operator text, and exit. Scheduling belongs to the caller.',
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
      OPTION_FORMAT,
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
        description:
          'Add structured details per delta, plus summaryLine and the backward-compatible line alias.',
      },
      {
        name: '--summaries',
        type: 'boolean',
        required: false,
        description:
          'Add a normalized semantic delta.summary to PR deltas (ciRollup, reviewDecision, mergeable, mergeStateStatus, state, isDraft, unresolvedReviewThreads, headSha) derived from the same observation as the opaque fingerprints, so a consumer reads the semantic state without a second GitHub fetch. Additive and off by default.',
      },
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
          'Attention filter: suppress new-comments only when every newly inferred bounded comment has a listed author. Fails open when the five-row window is incomplete or an author/id is missing.',
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
      OPTION_NO_REGISTRY,
      OPTION_LOCK_STALE_MS,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'detector-report-v1',
      reportFields: REPORT_FIELDS,
      deltaFields: DELTA_FIELDS,
      deltaDetailFields: DELTA_DETAIL_FIELDS,
      deltaDetailFieldsByClass: DELTA_DETAIL_FIELDS_BY_CLASS,
      deltaSummaryFields: DELTA_SUMMARY_FIELDS,
      deltaSummaryEnums: DELTA_SUMMARY_ENUMS,
      description:
        "JSON output contains schemaVersion, baseline, repo, repoSource ('flag' | 'git-remote' | 'gh', how --repo was resolved), monitorId, entities, stateFile (the resolved snapshot path), at, deltas, and summary fields. filteredDeltas is present whenever an attention-filter flag is supplied (including zero) and counts filter effects, including a removed class on a surviving delta; it is omitted without attention filters so the zero-new-flags output stays byte-identical. Every delta carries a stable content-addressed delta.id (64-char sha256 hex of repo, entity, number, and the observed to-state; from+classes+missingTicks when to is null) for idempotent dedupe; it excludes monitorId, so the same observed change from any monitor yields the same id. PR deltas with a current object also carry delta.headRefName (the PR head branch name, retained by GitHub even after the branch is deleted, contextual metadata that is NOT a change trigger); issue deltas and the missing lifecycle omit it. --summary-line adds delta.summaryLine, and --detail adds delta.details plus the backward-compatible delta.line alias. ci-changed and review-changed details name the exact checks/reviews that changed (added, removed, changed) when both fingerprint sides carry the persisted normalized summaries; opaque: true marks a digest transition the detail cannot name (e.g. a snapshot written before summaries were persisted). relabeled, assignees-changed, and review-requests-changed details carry added/removed arrays of names (teams as org/slug). --summaries adds a normalized delta.summary to every PR delta that has an observed to-state (a sibling of to, so delta.id is unchanged): ciRollup (green|failed|pending|none; a PR with zero checks is none, never green), reviewDecision (approved|changes_requested|review_required|none; none also covers \"no review-required rule\" and \"required but none submitted yet\", which GitHub does not distinguish here), mergeable (mergeable|conflicting|unknown; unknown means GitHub has not finished recomputing), mergeStateStatus (behind|blocked|clean|dirty|draft|has_hooks|unstable|unknown; the same observation's mergeStateStatus, where unknown means not reported/absent — fail-closed, treated like mergeable: unknown, so a PR that is mergeable yet behind its base or blocked by a protection rule is not mistaken for ready), state (open|closed|merged), isDraft (boolean), unresolvedReviewThreads (integer), and headSha (the head commit SHA). See output.deltaSummaryFields and output.deltaSummaryEnums for the exact field set and enum domains. The summary is an optional hint reflecting the same single observation as the fingerprints; consumers may re-derive authoritative facts themselves. The opaque fingerprints and the rest of the report shape are byte-identical whether or not --summaries is set. Error output is schemaVersion, error, kind, at, and optional repo and monitorId. Text output contains an operator heartbeat and suggested actions.",
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
        'JSON output contains schemaVersion, command ("list"), stateDir, registryDir (the run-registry directory consulted, or null when --state-dir narrowed the inventory), since (the echoed --since value or null), at, monitors, skippedFiles, and summary. Each monitor entry carries repo, monitorId, entities, stateFile, lastRun (snapshot meta.horizon when readable; registry lastRun or file mtime otherwise), and prCount/issueCount (null with an error string when the snapshot is corrupt, or with stale: true when a registered snapshot file no longer exists). Economical PR-watch snapshots additionally carry scope: "watch-pr". Entries are sorted by lastRun, newest first. skippedFiles counts directory entries that could not be identified as monitor snapshots or registry entries. summary is human-readable only; do not parse it.',
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
};

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
