// Generated schemas are derived from runtime catalogs: strict core contracts,
// while additive fields remain available to future compatible releases.
import {
  DELTA_CLASSES,
  DELTA_SUMMARY_ENUMS,
  ERROR_KINDS,
  REPORT_SCHEMA_VERSION,
} from './contract.mjs';

const object = { type: 'object', additionalProperties: true };
const warning = {
  type: 'object',
  required: ['label', 'reason'],
  properties: { label: { type: 'string' }, reason: { type: 'string' } },
  additionalProperties: true,
};
const error = {
  type: 'object',
  required: ['kind', 'message'],
  properties: {
    repo: { type: 'string' },
    kind: { enum: ERROR_KINDS },
    message: { type: 'string' },
    hint: { type: 'string' },
    resetAt: { type: 'string' },
  },
  additionalProperties: true,
};
const counts = {
  type: 'object',
  required: ['deltas', 'byClass', 'filteredDeltas'],
  properties: {
    deltas: { type: 'integer', minimum: 0 },
    byClass: {
      type: 'object',
      properties: Object.fromEntries(
        DELTA_CLASSES.map((name) => [name, { type: 'integer', minimum: 1 }]),
      ),
      additionalProperties: false,
    },
    filteredDeltas: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
};
// summary is a 3-way union: null (missing lifecycle), the full PR shape, or
// the minimal issue shape ({ state } only).
const summary = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      required: [
        'ciRollup',
        'reviewDecision',
        'mergeable',
        'mergeStateStatus',
        'state',
        'isDraft',
        'unresolvedReviewThreads',
        'headSha',
      ],
      properties: {
        ciRollup: { enum: DELTA_SUMMARY_ENUMS.ciRollup },
        reviewDecision: { enum: DELTA_SUMMARY_ENUMS.reviewDecision },
        mergeable: { enum: DELTA_SUMMARY_ENUMS.mergeable },
        mergeStateStatus: { enum: DELTA_SUMMARY_ENUMS.mergeStateStatus },
        state: { enum: DELTA_SUMMARY_ENUMS.state },
        isDraft: { type: 'boolean' },
        unresolvedReviewThreads: { type: 'integer', minimum: 0 },
        headSha: { type: 'string' },
      },
      additionalProperties: true,
    },
    {
      // additionalProperties: false makes this mutually exclusive with the
      // full PR shape above for `oneOf` -- a full PR summary always carries
      // extra fields (ciRollup, isDraft, ...) this minimal issue shape forbids.
      type: 'object',
      required: ['state'],
      properties: { state: { enum: DELTA_SUMMARY_ENUMS.state } },
      additionalProperties: false,
    },
  ],
};
const context = {
  type: 'object',
  properties: {
    id: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] },
    author: { type: ['string', 'null'] },
    createdAt: { type: ['string', 'null'] },
    headRefName: { type: ['string', 'null'] },
  },
  additionalProperties: true,
};
const rateLimit = {
  type: ['object', 'null'],
  properties: {
    cost: { type: 'integer', minimum: 0 },
    remaining: { type: 'integer', minimum: 0 },
    resetAt: { type: 'string' },
  },
};

// The delta object's shared property set -- one shape across json/compact/
// ndjson (see docs/contract.md). `firstObserved` (TODO(R6)) and `seq`
// (TODO(R4)) are reserved and never populated yet. The one deliberate
// per-format divergence is the detail-rows field name itself (`details` in
// json, `detail` in compact/ndjson, matching the existing runtime rename at
// lib/compact-output.mjs's compactDelta) -- everything else here is shared
// byte-for-byte by every format's delta schema.
function deltaCoreProperties() {
  return {
    id: { type: 'string' },
    repo: { type: 'string' },
    entity: { enum: ['pr', 'issue'] },
    number: { type: 'integer', minimum: 1 },
    context,
    classes: { type: 'array', minItems: 1, items: { enum: DELTA_CLASSES } },
    summary,
    changed: object,
    from: object,
    to: object,
    missingTicks: { type: 'integer', minimum: 1 },
    firstObserved: { type: 'string' }, // TODO(R6): reserved, not yet populated
    seq: { type: 'integer', minimum: 1 }, // TODO(R4): reserved, not yet populated
    summaryLine: { type: 'string' },
    enrichment: object,
    staleAt: { type: 'string' },
  };
}
const DELTA_CORE_REQUIRED = [
  'id',
  'repo',
  'entity',
  'number',
  'context',
  'classes',
  'summary',
  'changed',
];

function root(schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `gh-delta ${schema.title}`,
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...schema,
  };
}

// One row of report.results (json format) / the pre-repo error entries
// flattened into compact/ndjson's `errors` (see lib/compact-output.mjs).
const result = {
  type: 'object',
  required: ['repo', 'baseline', 'repoSource', 'stateFile', 'rateLimit'],
  properties: {
    repo: { type: 'string' },
    baseline: { type: 'boolean' },
    repoSource: { type: 'string' },
    stateFile: { type: 'string' },
    logFile: { type: 'string' },
    rateLimit,
    error: {
      type: 'object',
      required: ['kind', 'message'],
      properties: {
        kind: { enum: ERROR_KINDS },
        message: { type: 'string' },
        hint: { type: 'string' },
        resetAt: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

// The pre-flight bare error shape: raised before any repo is known/resolved
// (bad flags, a declined/failed --repo derivation, ...). Deliberately
// unrenamed (`at`, not `detectedAt`) and un-enveloped (no repos/results) --
// shared by the detector and every other subcommand's error path.
const bareError = {
  type: 'object',
  required: ['schemaVersion', 'at', 'error', 'kind'],
  properties: {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    at: { type: 'string' },
    error: { type: 'string' },
    kind: { enum: ERROR_KINDS },
    hint: { type: 'string' },
    repo: { type: 'string' },
    monitorId: { type: 'string' },
    resetAt: { type: 'string' },
  },
  additionalProperties: true,
};

function jsonSchema() {
  const delta = {
    type: 'object',
    properties: { ...deltaCoreProperties(), details: { type: 'array', items: object } },
    required: [...DELTA_CORE_REQUIRED, 'from', 'to'],
    additionalProperties: true,
  };
  const envelope = {
    type: 'object',
    required: [
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
    ],
    properties: {
      schemaVersion: { const: REPORT_SCHEMA_VERSION },
      detectedAt: { type: 'string' },
      monitorId: { type: 'string' },
      entities: { type: 'array', items: { enum: ['pr', 'issue'] } },
      repos: { type: 'array', items: { type: 'string' } },
      results: { type: 'array', items: result },
      deltas: { type: 'array', items: delta },
      filteredDeltas: { type: 'integer', minimum: 0 },
      warnings: { type: 'array', items: warning },
      summary: { type: 'string' },
    },
    additionalProperties: true,
  };
  return root({ title: 'JSON report', oneOf: [envelope, bareError] });
}

function compactSchema() {
  const delta = {
    type: 'object',
    properties: { ...deltaCoreProperties(), detail: { type: 'array', items: object } },
    required: DELTA_CORE_REQUIRED,
    additionalProperties: true,
  };
  const compactFields = {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    at: { type: 'string' },
    repos: { type: 'array', items: { type: 'string' } },
    baseline: { type: 'boolean' },
    counts,
    deltas: { type: 'array', items: delta },
    errors: { type: 'array', items: error },
    warnings: { type: 'array', items: warning },
  };
  // `repos`/`baseline`/`errors` are all optional here: a bare pre-flight error
  // (no repo ever resolved -- see lib/cli.mjs's run()) still renders through
  // compactReport, just without a `repos` key and with its one error folded
  // into `errors` instead of a top-level `repos`/`results` envelope.
  const envelope = {
    type: 'object',
    required: ['schemaVersion', 'at', 'counts', 'deltas', 'warnings'],
    properties: compactFields,
    additionalProperties: true,
  };
  return root({ title: 'compact report', ...envelope });
}

function ndjsonSchema() {
  const delta = {
    type: 'object',
    properties: {
      type: { const: 'delta' },
      ...deltaCoreProperties(),
      detail: { type: 'array', items: object },
    },
    required: ['type', ...DELTA_CORE_REQUIRED],
    additionalProperties: true,
  };
  const endFields = {
    type: { const: 'end' },
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    at: { type: 'string' },
    repos: { type: 'array', items: { type: 'string' } },
    baseline: { type: 'boolean' },
    counts,
    errors: { type: 'array', items: error },
    warnings: { type: 'array', items: warning },
    exitCode: { enum: [0, 1, 2, 10] },
  };
  // `repos` is optional here for the same reason as compactSchema's envelope:
  // a bare pre-flight error still renders one `end` record via ndjsonReport,
  // just without a `repos` key.
  const end = {
    type: 'object',
    required: ['type', 'schemaVersion', 'at', 'counts', 'warnings', 'exitCode'],
    properties: endFields,
    additionalProperties: true,
  };
  return root({ title: 'NDJSON record', oneOf: [delta, end] });
}

export function schemaFor(format = 'json') {
  if (format === 'json') return jsonSchema();
  if (format === 'compact') return compactSchema();
  if (format === 'ndjson') return ndjsonSchema();
  throw new TypeError('--format must be json, compact, or ndjson');
}

// Exported for the schema.test.mjs structural guardrail: every format's delta
// schema is built from this one shared property set (see deltaCoreProperties
// above), so a future edit cannot silently diverge the formats' common fields.
export { deltaCoreProperties, DELTA_CORE_REQUIRED };
