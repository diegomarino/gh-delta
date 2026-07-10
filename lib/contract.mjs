// Runtime contract constants. Additive changes (new classes, kinds, fields)
// never bump the schema versions; only a rename or removal does.
export const REPORT_SCHEMA_VERSION = 1;
export const OUTPOST_SCHEMA_VERSION = 1;

export const ERROR_KINDS = Object.freeze(['config', 'snapshot', 'github', 'io']);

export const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'baseline',
  'repo',
  'monitorId',
  'entities',
  'stateFile',
  'at',
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
  'repo',
  'monitorId',
  'entities',
  'stateFile',
  'lastRun',
  'prCount',
  'issueCount',
  'stale',
  'error',
]);

export const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'registryVersion',
  'repo',
  'monitorId',
  'entities',
  'stateFile',
  'lastRun',
]);

export const DELTA_FIELDS = Object.freeze([
  'id',
  'entity',
  'number',
  'title',
  'headRefName',
  'classes',
  'from',
  'to',
  'summary',
  'missingTicks',
  'summaryLine',
  'line',
  'details',
]);

// Normalized semantic summary attached to PR deltas under `--summaries`. Additive
// and optional: a delta carries `summary` only when the flag is set and the delta
// is a PR with an observed `to` state. See lib/summary.mjs for the derivation.
export const DELTA_SUMMARY_FIELDS = Object.freeze([
  'ciRollup',
  'reviewDecision',
  'mergeable',
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
  'ci-changed',
  'review-changed',
  'became-mergeable',
  'unresolved-threads-added',
  'unresolved-threads-resolved',
  'review-threads-changed',
  'relabeled',
]);

export const DELTA_DETAIL_FIELDS_BY_CLASS = Object.freeze({
  new: Object.freeze(['presence', 'state']),
  'first-seen': Object.freeze(['presence', 'state']),
  closed: Object.freeze(['state']),
  reopened: Object.freeze(['state']),
  'new-comments': Object.freeze(['comments']),
  updated: Object.freeze([
    'ci',
    'comments',
    'head',
    'isDraft',
    'labels',
    'mergeable',
    'review',
    'reviewThreads',
    'reviews',
    'state',
    'unresolvedReviewThreads',
    'updatedAt',
  ]),
  missing: Object.freeze(['presence']),
  'still-missing': Object.freeze(['presence']),
  'presumed-deleted': Object.freeze(['presence']),
  reappeared: Object.freeze(['presence']),
  merged: Object.freeze(['state']),
  'draft-ready': Object.freeze(['isDraft']),
  'ci-changed': Object.freeze(['ci']),
  'review-changed': Object.freeze(['review', 'reviews']),
  'became-mergeable': Object.freeze(['mergeable']),
  'unresolved-threads-added': Object.freeze(['unresolvedReviewThreads']),
  'unresolved-threads-resolved': Object.freeze(['unresolvedReviewThreads']),
  'review-threads-changed': Object.freeze(['reviewThreads']),
  relabeled: Object.freeze(['labels']),
});
