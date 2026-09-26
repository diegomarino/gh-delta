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

// `from`/`to`: the bare compared fingerprint (or `null` for the new/first-seen
// -- `from` -- and missing/still-missing/presumed-deleted -- `to` -- lifecycle
// edges), never the full snapshot item. Properties are the union of PR and
// issue fingerprint fields; none are `required` here since neither entity
// carries every field and the set is additive (see docs/contract.md's
// Fingerprint fields table) -- this describes the shape without over-fitting
// either entity kind.
const fingerprint = {
  type: ['object', 'null'],
  properties: {
    state: { type: 'string' },
    updatedAt: { type: 'string' },
    isDraft: { type: 'boolean' },
    headSha: { type: 'string' },
    baseRef: { type: 'string' },
    mergeable: { type: 'string' },
    mergeStateStatus: { type: 'string' },
    reviewDecision: { type: 'string' },
    checks: { type: 'array', items: object },
    reviews: { type: 'array', items: object },
    threads: { type: 'array', items: object },
    conversationComments: { type: 'integer', minimum: 0 },
    reviewComments: { type: 'integer', minimum: 0 },
    recentComments: { type: 'array', items: object },
    labels: { type: 'array', items: { type: 'string' } },
    assignees: { type: 'array', items: { type: 'string' } },
    reviewRequests: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};

// The ONE delta definition shared by json/compact/ndjson (see docs/contract.md).
// Every format's schema places this literal object under its own `$defs.delta`
// and references it via `$ref: '#/$defs/delta'` -- never a second, independently
// maintained copy. Per-format differences (json requires from/to; the ndjson
// `delta` record adds a `type` discriminator) are layered on top with `allOf`
// plus an incremental `required` list, never by forking this definition.
// `firstObserved` is `true` (never `false`, only present or absent) for the
// `new`/`first-seen`/`baseline-state` classes. `seq` is populated by R4: the
// delta's journal record number when the run used --log, present only then
// (never null -- absence IS the "no log" signal at the report level; the
// outpost payload's own top-level `seq` is the one that carries null
// explicitly). The one deliberate per-format property divergence is the
// detail-rows field name (`details` in json, `detail` in compact/ndjson,
// matching the existing runtime rename at lib/compact-output.mjs's
// compactDelta); both names are declared here so no format needs its own copy
// of the definition just to add one extra optional property.
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
function deltaDef() {
  return {
    type: 'object',
    required: DELTA_CORE_REQUIRED,
    properties: {
      id: { type: 'string' },
      repo: { type: 'string' },
      entity: { enum: ['pr', 'issue'] },
      number: { type: 'integer', minimum: 1 },
      context,
      classes: { type: 'array', minItems: 1, items: { enum: DELTA_CLASSES } },
      summary,
      changed: object,
      from: fingerprint,
      to: fingerprint,
      missingTicks: { type: 'integer', minimum: 1 },
      firstObserved: { const: true },
      seq: { type: 'integer', minimum: 1 }, // journal record number; present only with --log
      summaryLine: { type: 'string' },
      enrichment: object,
      staleAt: { type: 'string' },
      details: { type: 'array', items: object },
      detail: { type: 'array', items: object },
    },
    additionalProperties: true,
  };
}
// Reference the shared def plus an incremental, format-specific layer -- the
// ONLY axis of divergence between formats. `required` adds more required
// properties (from/to for json); `properties` adds a genuinely new property
// no other format's delta usage carries (the ndjson delta record's `type`
// discriminator). Neither ever redefines a property the shared def already
// declares.
function deltaRef({ required = [], properties } = {}) {
  const extra = {
    ...(required.length ? { required } : {}),
    ...(properties ? { properties } : {}),
  };
  return {
    allOf: [{ $ref: '#/$defs/delta' }, ...(Object.keys(extra).length ? [extra] : [])],
  };
}

function root(schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `gh-delta ${schema.title}`,
    schemaVersion: REPORT_SCHEMA_VERSION,
    // One shared delta definition per document, referenced everywhere a delta
    // appears via `$ref: '#/$defs/delta'` (see deltaDef/deltaRef above) --
    // never a second, independently maintained copy.
    $defs: { delta: deltaDef() },
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
        remaining: { type: 'integer', minimum: 0 },
        cost: { type: 'integer', minimum: 0 },
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
  const delta = deltaRef({ required: ['from', 'to'] });
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
  const delta = deltaRef();
  const compactFields = {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    detectedAt: { type: 'string' },
    repos: { type: 'array', items: { type: 'string' } },
    baseline: { type: 'boolean' },
    counts,
    deltas: { type: 'array', items: delta },
    errors: { type: 'array', items: error },
    warnings: { type: 'array', items: warning },
  };
  // `repos`/`baseline`/`errors` are all optional here: a bare pre-flight error
  // (no repo ever resolved -- see lib/cli/runner.mjs's run()) still renders through
  // compactReport, just without a `repos` key and with its one error folded
  // into `errors` instead of a top-level `repos`/`results` envelope.
  const envelope = {
    type: 'object',
    required: ['schemaVersion', 'detectedAt', 'counts', 'deltas', 'warnings'],
    properties: compactFields,
    additionalProperties: true,
  };
  return root({ title: 'compact report', ...envelope });
}

function ndjsonSchema() {
  const delta = deltaRef({ required: ['type'], properties: { type: { const: 'delta' } } });
  const endFields = {
    type: { const: 'end' },
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    detectedAt: { type: 'string' },
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
    required: ['type', 'schemaVersion', 'detectedAt', 'counts', 'warnings', 'exitCode'],
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
// usage is a `$ref` to this one shared `$defs.delta` (see deltaDef/deltaRef
// above), so a future edit cannot silently diverge the formats' common fields.
export { DELTA_CORE_REQUIRED };
