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
    resetAt: { type: 'string' },
  },
  additionalProperties: true,
};
const counts = {
  type: 'object',
  required: ['deltas', 'byClass'],
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
  ],
};
const forbiddenAgentFields = {
  not: {
    anyOf: ['from', 'to', 'summaryLine', 'line', 'details', 'updatedAt'].map((name) => ({
      required: [name],
    })),
  },
};
const agentDelta = {
  type: 'object',
  required: ['id', 'repo', 'entity', 'number', 'title', 'url', 'classes', 'summary', 'changed'],
  properties: {
    id: { type: 'string' },
    repo: { type: 'string' },
    entity: { enum: ['pr', 'issue'] },
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string' },
    url: { type: 'string' },
    classes: { type: 'array', minItems: 1, items: { enum: DELTA_CLASSES } },
    summary,
    changed: object,
    missingTicks: { type: 'integer', minimum: 1 },
    enrichment: object,
    detail: { type: 'array', items: object },
  },
  additionalProperties: true,
  ...forbiddenAgentFields,
};
function root(schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `gh-delta ${schema.title}`,
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...schema,
  };
}
const core = {
  schemaVersion: { const: REPORT_SCHEMA_VERSION },
  at: { type: 'string' },
  warnings: { type: 'array', items: warning },
  errors: { type: 'array', items: error },
};
const compactFields = {
  ...core,
  repo: { type: 'string' },
  repos: { type: 'array', items: { type: 'string' } },
  baseline: { type: 'boolean' },
  counts,
  deltas: { type: 'array', items: agentDelta },
};
function compactSchema() {
  const single = {
    type: 'object',
    required: ['schemaVersion', 'repo', 'at', 'baseline', 'counts', 'deltas'],
    properties: compactFields,
    additionalProperties: true,
  };
  const multi = {
    type: 'object',
    required: ['schemaVersion', 'repos', 'at', 'counts', 'deltas', 'errors'],
    properties: compactFields,
    additionalProperties: true,
  };
  const failed = {
    type: 'object',
    required: ['schemaVersion', 'at', 'counts', 'deltas', 'errors'],
    properties: { ...compactFields, errors: { type: 'array', minItems: 1, items: error } },
    additionalProperties: true,
  };
  return root({ title: 'compact report', anyOf: [single, multi, failed] });
}
function jsonSchema() {
  const fields = {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    at: { type: 'string' },
    baseline: { type: 'boolean' },
    repo: { type: 'string' },
    repos: { type: 'array', items: { type: 'string' } },
    monitorId: { type: 'string' },
    entities: { type: 'array', items: { enum: ['pr', 'issue'] } },
    stateFile: { type: 'string' },
    deltas: { type: 'array' },
    error: { type: 'string' },
    kind: { enum: ERROR_KINDS },
    warnings: { type: 'array', items: warning },
  };
  return root({
    title: 'legacy JSON report',
    oneOf: [
      {
        type: 'object',
        required: ['schemaVersion', 'at', 'deltas'],
        properties: fields,
        additionalProperties: true,
      },
      {
        type: 'object',
        required: ['schemaVersion', 'at', 'error', 'kind'],
        properties: fields,
        additionalProperties: true,
      },
    ],
  });
}
function ndjsonSchema() {
  const endFields = {
    ...core,
    repo: { type: 'string' },
    repos: { type: 'array', items: { type: 'string' } },
    baseline: { type: 'boolean' },
    counts,
    exitCode: { enum: [0, 1, 2, 10] },
  };
  const delta = {
    type: 'object',
    required: ['type', ...agentDelta.required],
    properties: { type: { const: 'delta' }, ...agentDelta.properties },
    additionalProperties: true,
    ...forbiddenAgentFields,
  };
  const singleEnd = {
    type: 'object',
    required: ['type', 'schemaVersion', 'at', 'repo', 'baseline', 'counts', 'exitCode'],
    properties: { type: { const: 'end' }, ...endFields },
    additionalProperties: true,
  };
  const multiEnd = {
    type: 'object',
    required: ['type', 'schemaVersion', 'at', 'repos', 'counts', 'exitCode'],
    properties: { type: { const: 'end' }, ...endFields },
    additionalProperties: true,
  };
  const errorEnd = {
    type: 'object',
    required: ['type', 'schemaVersion', 'at', 'counts', 'errors', 'exitCode'],
    properties: {
      type: { const: 'end' },
      ...endFields,
      errors: { type: 'array', minItems: 1, items: error },
      exitCode: { enum: [1, 2] },
    },
    additionalProperties: true,
  };
  return root({ title: 'NDJSON record', oneOf: [delta, singleEnd, multiEnd, errorEnd] });
}
export function schemaFor(format = 'json') {
  if (format === 'json') return jsonSchema();
  if (format === 'compact') return compactSchema();
  if (format === 'ndjson') return ndjsonSchema();
  throw new TypeError('--format must be json, compact, or ndjson');
}
