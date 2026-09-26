import { commandHelp, SCHEMA_OPTIONS, formatSniff } from '../parse.mjs';
import { parseArgs } from 'node:util';
import { errorResult } from '../errors.mjs';
import { schemaFor } from '../../schema.mjs';

// deps keeps the CLI testable without shelling out to gh or touching disk.
/**
 * Run one detector pass and return a machine-readable result.
 *
 * The function performs argument validation, fetches requested GitHub entity
 * families, compares them with the prior snapshot, and writes the next snapshot
 * only after a successful fetch and diff. It never exits the process directly.
 * A leading `list` token routes to the read-only inventory subcommand instead.
 */
function runSchema(argv, deps = {}) {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const help = commandHelp(argv, 'gh-delta schema');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: SCHEMA_OPTIONS }));
  } catch (err) {
    return errorResult('config', String(err), { at, command: 'schema' }, formatSniff(argv));
  }
  if (!['json', 'compact', 'ndjson'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json, compact, or ndjson',
      { at, command: 'schema' },
      'json',
    );
  return { code: 0, report: schemaFor(values.format), format: 'schema' };
}

export { runSchema };
