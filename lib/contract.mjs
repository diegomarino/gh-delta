// Runtime contract constants. Additive changes (new classes, kinds, fields)
// never bump the schema versions; only a rename or removal does.
export const REPORT_SCHEMA_VERSION = 1;
export const OUTPOST_SCHEMA_VERSION = 1;

export const ERROR_KINDS = Object.freeze([
  'config',
  'snapshot',
  'github',
  'io',
  'busy',
  'log',
  'rate-limit',
]);

export const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'baseline',
  'repo',
  'repos',
  'errors',
  'repoSource',
  'monitorId',
  'entities',
  'scope',
  'stateFile',
  'logFile',
  'at',
  'deltas',
  'filteredDeltas',
  'summary',
  'warnings',
]);

export const DELTA_LOG_RECORD_FIELDS = Object.freeze(['seq', 'id', 'detectedAt', 'delta']);
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
export const CURSOR_SET_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'at',
  'repo',
  'repos',
  'monitorId',
  'cursor',
  'summary',
]);
export const CURSOR_SET_CURSOR_FIELDS = Object.freeze(['path', 'logFile', 'from', 'to']);
export const WAIT_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'command',
  'at',
  'repo',
  'repos',
  'monitorId',
  'iterations',
  'reason',
  'deltas',
  'errors',
  'summary',
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
  'repo',
  'monitorId',
  'entities',
  'scope',
  'stateFile',
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
  'lastRun',
  'machineId',
  'lastAttemptAt',
  'lastOkAt',
  'lastError',
]);

export const DELTA_FIELDS = Object.freeze([
  'id',
  'repo',
  'entity',
  'number',
  'title',
  'headRefName',
  'classes',
  'from',
  'to',
  'summary',
  'enrichment',
  'missingTicks',
  'summaryLine',
  'line',
  'details',
  'staleAt',
]);

// Agent formats deliberately have their own shape catalogs: COMPACT_REPORT_FIELDS
// above belongs to `gh-delta log compact`, not detector `--format compact`.
export const AGENT_COMPACT_REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'repo',
  'repos',
  'at',
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
  'title',
  'url',
  'classes',
  'summary',
  'changed',
  'missingTicks',
  'enrichment',
  'detail',
]);
export const AGENT_NDJSON_END_FIELDS = Object.freeze([
  'type',
  'schemaVersion',
  'at',
  'repo',
  'repos',
  'baseline',
  'counts',
  'errors',
  'warnings',
  'exitCode',
]);

// Normalized semantic summary attached to PR deltas under `--summaries`. Additive
// and optional: a delta carries `summary` only when the flag is set and the delta
// is a PR with an observed `to` state. See lib/summary.mjs for the derivation.
export const DELTA_SUMMARY_FIELDS = Object.freeze([
  'ciRollup',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'state',
  'isDraft',
  'unresolvedReviewThreads',
  'headSha',
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
  'note',
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
]);

export const DELTA_DETAIL_FIELDS_BY_CLASS = Object.freeze({
  new: Object.freeze(['presence', 'state']),
  'first-seen': Object.freeze(['presence', 'state']),
  'baseline-state': Object.freeze(['presence', 'state']),
  closed: Object.freeze(['state']),
  reopened: Object.freeze(['state']),
  'new-comments': Object.freeze(['comments']),
  'comments-removed': Object.freeze(['comments']),
  updated: Object.freeze([
    'assignees',
    'baseRef',
    'checks',
    'comments',
    'headSha',
    'isDraft',
    'labels',
    'mergeable',
    'mergeStateStatus',
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
});
