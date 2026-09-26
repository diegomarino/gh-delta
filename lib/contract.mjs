// Runtime contract constants. Additive changes (new classes, kinds, fields)
// never bump the schema versions; only a rename or removal does.
export const REPORT_SCHEMA_VERSION = 2;
export const OUTPOST_SCHEMA_VERSION = 2;

export const ERROR_KINDS = Object.freeze([
  'config',
  'snapshot',
  'github',
  'io',
  'busy',
  'log',
  'rate-limit',
]);

// The detector command's own report envelope (schema v2). One shape for
// single- and multi-repo runs alike: `repos`/`results` are always present,
// `results[]` carries per-repo baseline/state/quota/error facts (see
// REPORT_RESULT_FIELDS), and `deltas` is the flattened union across repos.
// This does NOT govern the pre-flight bare-error shape (a config error raised
// before any repo is known/resolved keeps its historical
// `{schemaVersion, error, kind, hint, at, ...}` shape, untouched by R3), nor
// any other subcommand's report (list/status/watch/read/log compact/reset/
// cursor set/schema/init/doctor/explain/demo keep their own `at`-based shapes).
export const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'detectedAt',
  'monitorId',
  'entities',
  'repos',
  'results',
  'deltas',
  'filteredDeltas',
  'warnings',
  'summary',
]);

// One row of REPORT_FIELDS.results -- per-repo tick facts. `logFile`/`error`
// are omitted (never null) when not applicable; `rateLimit` is the F3
// accumulated-quota shape ({cost, remaining, resetAt}) or null when no
// GraphQL call was made this tick.
export const REPORT_RESULT_FIELDS = Object.freeze([
  'repo',
  'baseline',
  'repoSource',
  'stateFile',
  'logFile',
  'rateLimit',
  'error',
]);

export const DELTA_LOG_RECORD_FIELDS = Object.freeze([
  'seq',
  'id',
  'detectedAt',
  'delta',
  'repo',
  'monitorId',
]);
export const CURSOR_FILE_FIELDS = Object.freeze(['cursorVersion', 'logFile', 'seq']);
export const READ_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'logFile',
  'at',
  'cursor',
  'deltas',
  'summary',
  'warnings',
]);
export const READ_CURSOR_FIELDS = Object.freeze(['path', 'from', 'to', 'advanced']);
export const COMPACT_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'logFile',
  'at',
  'keep',
  'previous',
  'retained',
  'summary',
]);
export const COMPACT_BOUNDS_FIELDS = Object.freeze(['firstSeq', 'lastSeq', 'count']);
export const RESET_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'stateFile',
  'logFile',
  'at',
  'summary',
  'targets',
]);
export const RESET_TARGET_FIELDS = Object.freeze([
  'scope',
  'stateFile',
  'logFile',
  'removed',
  'missing',
]);
// `cursor set` takes only `<cursor-path> <seq>` positionals plus --log-file
// (CURSOR_SET_OPTIONS) -- it has no --repo/--monitor-id flags at all, so
// there is no code path that can ever attach those fields to this report.
export const CURSOR_SET_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'at',
  'cursor',
  'summary',
]);
export const CURSOR_SET_CURSOR_FIELDS = Object.freeze(['path', 'logFile', 'from', 'to']);
// `wait`'s tick is always either run() (whose report ALWAYS carries `repos`,
// plural, for any resolved repo -- schema v2 unified this; see REPORT_FIELDS)
// or, under --from-log, `read`'s report (which carries neither `repo` nor
// `repos` at all). No code path here ever produces a singular `repo`.
//
// `errors` is also absent: any tick error (a per-repo `results[].error`, or a
// bare pre-flight `report.error`) forces that tick's own exit code to 1 or 2
// (see buildDetectorReport's anyError/anyPermanent), and lib/wait.mjs's
// runBoundedWait treats any 1-or-2 tick as immediately terminal, setting
// `reason: 'error'` in the same step. That reason takes the OTHER return
// branch in lib/cli/commands/wait.mjs's runWait (the bare error shape, not this one) --
// so a report with this shape can never carry a non-empty `errors`.
export const WAIT_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'at',
  'repos',
  'monitorId',
  'iterations',
  'reason',
  'deltas',
  'summary',
  'warnings',
]);

export const LIST_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'stateDir',
  'registryDir',
  'since',
  'at',
  'monitors',
  'skippedFiles',
  'summary',
]);

export const LIST_MONITOR_FIELDS = Object.freeze([
  'registryEntry',
  'repo',
  'monitorId',
  'entities',
  'scope',
  'schemaVersion',
  'stateFile',
  'watchDir',
  'lastRun',
  'prCount',
  'issueCount',
  'stale',
  'error',
  'lastAttemptAt',
  'lastOkAt',
  'lastError',
  'observationAgeMs',
  'snapshotStatus',
  'watched',
  'watchError',
]);

export const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'registryVersion',
  'repo',
  'monitorId',
  'entities',
  'scope',
  'stateFile',
  'watchDir',
  'lastRun',
  'machineId',
  'lastAttemptAt',
  'lastOkAt',
  'lastError',
]);

// The delta object: one shape across json/compact/ndjson (only from/to
// presence differs -- always in json, opt-in via --full in compact/ndjson).
// `firstObserved` is `true` at the delta top level (never `false`, only
// present or absent) for the `new`, `first-seen`, and `baseline-state`
// classes -- a fact about this occurrence, derived from `classes`, not
// identity/display of the item (see DELTA_CONTEXT_FIELDS). It never enters
// delta.id (deltaIdentity hashes only fingerprint/classes/missingTicks).
// `seq` is populated by R4 (lib/cli/detector.mjs, sourced from appendDeltaLog's
// {fromSeq, toSeq} return value): the delta's journal record number when the
// run used --log, absent otherwise.
export const DELTA_FIELDS = Object.freeze([
  'id',
  'repo',
  'entity',
  'number',
  'context',
  'classes',
  'summary',
  'changed',
  'from',
  'to',
  'missingTicks',
  'firstObserved',
  'seq',
  'summaryLine',
  'details',
  'enrichment',
  'staleAt',
]);

// The `context` section of a delta: identity/display fields, never compared
// and never hashed into delta.id. On the missing lifecycle (to === null)
// `context` (including `title`) is the last-known value from the snapshot,
// not necessarily current; `headRefName` is PR-only.
export const DELTA_CONTEXT_FIELDS = Object.freeze([
  'id',
  'title',
  'url',
  'author',
  'createdAt',
  'headRefName',
]);

// Agent formats deliberately have their own shape catalogs: COMPACT_REPORT_FIELDS
// above belongs to `gh-delta log compact`, not detector `--format compact`.
export const AGENT_COMPACT_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'repos',
  'detectedAt',
  'baseline',
  'counts',
  'deltas',
  'errors',
  'warnings',
]);
export const AGENT_COMPACT_DELTA_FIELDS = Object.freeze([
  'id',
  'repo',
  'entity',
  'number',
  'context',
  'classes',
  'summary',
  'changed',
  'missingTicks',
  'firstObserved',
  'seq',
  'enrichment',
  'detail',
  'from',
  'to',
]);
export const AGENT_NDJSON_END_FIELDS = Object.freeze([
  'type',
  'schemaVersion',
  'detectedAt',
  'repos',
  'baseline',
  'counts',
  'errors',
  'warnings',
  'exitCode',
]);

// Normalized semantic summary attached to PR deltas. Unconditional: every
// delta with an observed `to` state carries `summary` (PR deltas get the
// full shape below, issue deltas the minimal `{ state }` -- see
// lib/summary.mjs for the derivation).
export const DELTA_SUMMARY_FIELDS = Object.freeze([
  'ciRollup',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'state',
  'isDraft',
  'unresolvedReviewThreads',
  'headSha',
  'failedChecks',
]);

// Closed enum domains for the typed summary fields, so a consumer can build a
// Zod/JSON-Schema validator from the help/contract alone. `unresolvedReviewThreads`
// is a non-negative integer and `headSha` a (possibly empty) hex string.
export const DELTA_SUMMARY_ENUMS = Object.freeze({
  ciRollup: Object.freeze(['green', 'failed', 'pending', 'none']),
  reviewDecision: Object.freeze(['approved', 'changes_requested', 'review_required', 'none']),
  mergeable: Object.freeze(['mergeable', 'conflicting', 'unknown']),
  mergeStateStatus: Object.freeze([
    'behind',
    'blocked',
    'clean',
    'dirty',
    'draft',
    'has_hooks',
    'unstable',
    'unknown',
  ]),
  state: Object.freeze(['open', 'closed', 'merged']),
});

// `note`/`field: 'unknown'` is deliberately absent: detailForClass's `default`
// branch that would emit it only fires for a class value outside
// DELTA_CLASSES, and the switch in lib/cli/delta-details.mjs has a case for every one of
// DELTA_CLASSES' entries -- no real delta can ever reach that branch.
export const DELTA_DETAIL_FIELDS = Object.freeze([
  'class',
  'field',
  'from',
  'to',
  'delta',
  'added',
  'removed',
  'changed',
  'missingTicks',
  'opaque',
]);

export const DELTA_CLASSES = Object.freeze([
  'new',
  'first-seen',
  'baseline-state',
  'closed',
  'reopened',
  'new-comments',
  'updated',
  'missing',
  'still-missing',
  'presumed-deleted',
  'reappeared',
  'merged',
  'draft-ready',
  'converted-to-draft',
  'ci-changed',
  'review-changed',
  'became-mergeable',
  'became-conflicting',
  'head-changed',
  'stale',
  'unresolved-threads-added',
  'unresolved-threads-resolved',
  'review-threads-changed',
  'relabeled',
  'comments-removed',
  'assignees-changed',
  'review-requests-changed',
  'base-changed',
  'review-comments-added',
  'review-comments-removed',
]);

export const DELTA_DETAIL_FIELDS_BY_CLASS = Object.freeze({
  new: Object.freeze(['presence', 'state']),
  'first-seen': Object.freeze(['presence', 'state']),
  'baseline-state': Object.freeze(['presence', 'state']),
  closed: Object.freeze(['state']),
  reopened: Object.freeze(['state']),
  'new-comments': Object.freeze(['conversationComments']),
  'comments-removed': Object.freeze(['conversationComments']),
  updated: Object.freeze([
    'assignees',
    'baseRef',
    'checks',
    'conversationComments',
    'headSha',
    'isDraft',
    'labels',
    'mergeable',
    'mergeStateStatus',
    'reviewComments',
    'reviewDecision',
    'reviewRequests',
    'reviewThreads',
    'reviews',
    'state',
    'threads',
    'unresolvedReviewThreads',
    'updatedAt',
  ]),
  missing: Object.freeze(['presence']),
  'still-missing': Object.freeze(['presence']),
  'presumed-deleted': Object.freeze(['presence']),
  reappeared: Object.freeze(['presence']),
  merged: Object.freeze(['state']),
  'draft-ready': Object.freeze(['isDraft']),
  'converted-to-draft': Object.freeze(['isDraft']),
  'ci-changed': Object.freeze(['checks']),
  'review-changed': Object.freeze(['reviewDecision', 'reviews']),
  'became-mergeable': Object.freeze(['mergeable']),
  'became-conflicting': Object.freeze(['mergeable']),
  'head-changed': Object.freeze(['headSha']),
  stale: Object.freeze(['staleAt']),
  'unresolved-threads-added': Object.freeze(['unresolvedReviewThreads', 'threads']),
  'unresolved-threads-resolved': Object.freeze(['unresolvedReviewThreads', 'threads']),
  'review-threads-changed': Object.freeze(['reviewThreads']),
  relabeled: Object.freeze(['labels']),
  'assignees-changed': Object.freeze(['assignees']),
  'review-requests-changed': Object.freeze(['reviewRequests']),
  'base-changed': Object.freeze(['baseRef']),
  'review-comments-added': Object.freeze(['reviewComments']),
  'review-comments-removed': Object.freeze(['reviewComments']),
});
