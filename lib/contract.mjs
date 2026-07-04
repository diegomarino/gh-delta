// Runtime contract constants. Additive changes (new classes, kinds, fields)
// never bump the schema versions; only a rename or removal does.
export const REPORT_SCHEMA_VERSION = 1;
export const OUTPOST_SCHEMA_VERSION = 1;

export const ERROR_KINDS = Object.freeze(['config', 'snapshot', 'github', 'io']);

export const DELTA_CLASSES = Object.freeze([
  'new',
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
