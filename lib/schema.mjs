// JSON Schema generation is code rather than hand-maintained JSON so catalog
// changes cannot silently leave published agent artifacts behind.
import { DELTA_CLASSES, ERROR_KINDS, REPORT_SCHEMA_VERSION } from './contract.mjs';

const scalar = {};
const counts = {
  type: 'object',
  required: ['deltas', 'byClass'],
  properties: {
    deltas: { type: 'integer', minimum: 0 },
    byClass: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
    filteredDeltas: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
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
    summary: { type: ['object', 'null'] },
    changed: { type: 'object' },
    missingTicks: { type: 'integer', minimum: 1 },
    enrichment: scalar,
    detail: { type: 'array' },
  },
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
function root(schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `gh-delta ${schema.title}`,
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...schema,
  };
}
function compactSchema() {
  return root({
    title: 'compact report',
    type: 'object',
    required: ['schemaVersion', 'at', 'counts', 'deltas'],
    properties: {
      schemaVersion: { const: REPORT_SCHEMA_VERSION },
      repo: { type: 'string' },
      repos: { type: 'array', items: { type: 'string' } },
      at: { type: 'string' },
      baseline: { type: 'boolean' },
      counts,
      deltas: { type: 'array', items: agentDelta },
      errors: { type: 'array', items: error },
      warnings: { type: 'array' },
    },
    additionalProperties: true,
  });
}
function jsonSchema() {
  return root({
    title: 'legacy JSON report',
    type: 'object',
    required: ['schemaVersion', 'at'],
    properties: {
      schemaVersion: { const: REPORT_SCHEMA_VERSION },
      at: { type: 'string' },
      deltas: { type: 'array' },
      error: { type: 'string' },
      kind: { enum: ERROR_KINDS },
    },
    additionalProperties: true,
  });
}
function ndjsonSchema() {
  return root({
    title: 'NDJSON record',
    oneOf: [
      {
        type: 'object',
        required: ['type', ...agentDelta.required],
        properties: { type: { const: 'delta' }, ...agentDelta.properties },
        additionalProperties: true,
      },
      {
        type: 'object',
        required: ['type', 'schemaVersion', 'at', 'counts', 'exitCode'],
        properties: {
          type: { const: 'end' },
          schemaVersion: { const: REPORT_SCHEMA_VERSION },
          at: { type: 'string' },
          repo: { type: 'string' },
          repos: { type: 'array', items: { type: 'string' } },
          counts,
          errors: { type: 'array', items: error },
          warnings: { type: 'array' },
          exitCode: { enum: [0, 1, 2, 10] },
        },
        additionalProperties: true,
      },
    ],
  });
}
export function schemaFor(format = 'json') {
  if (format === 'json') return jsonSchema();
  if (format === 'compact') return compactSchema();
  if (format === 'ndjson') return ndjsonSchema();
  throw new TypeError('--format must be json, compact, or ndjson');
}
