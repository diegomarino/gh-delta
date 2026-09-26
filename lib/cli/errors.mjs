// Shared CLI error envelopes, exit codes, and recovery hints.
import { REPORT_SCHEMA_VERSION } from '../contract.mjs';
// Permanent errors exit 2; transient errors exit 1. `busy` (state-file lock
// held or unresolvable) is transient: the next tick retries.
const ERROR_EXIT_CODES = {
  config: 2,
  snapshot: 2,
  github: 1,
  io: 1,
  busy: 1,
  log: 2,
  'rate-limit': 1,
};

function errorHint(kind, error) {
  const message = String(error ?? '').toLowerCase();
  if (kind === 'github' && (message.includes('scope') || message.includes('organization')))
    return 'Token may lack read:org; run gh auth refresh -s read:org, then gh-delta doctor.';
  if (kind === 'github')
    return 'Check gh authentication and connectivity with gh-delta doctor, then retry.';
  if (kind === 'rate-limit')
    return 'Wait until resetAt, lower --rate-limit-floor, or inspect quota with gh-delta doctor.';
  if (kind === 'busy')
    return 'Another monitor owns this state file; wait for it to finish or use a distinct --monitor-id.';
  if (kind === 'snapshot')
    return 'Inspect the state file; restore valid JSON, choose a new durable --state-dir, or run `gh-delta reset` to start a clean baseline.';
  if (kind === 'log')
    return 'Inspect the durable delta log and cursor before retrying (do not truncate it automatically); a cursor pointing past the tail or a pre-schema-v2 log is fixed by deleting the cursor and/or running `gh-delta reset` to start a clean baseline.';
  if (kind === 'io')
    return 'Check the state directory exists and is writable, then run gh-delta doctor.';
  return 'Fix the command configuration, or run gh-delta doctor for a local diagnostic.';
}

// Build a structured error result with kind, exit code, and report.
// context holds optional { repo, monitorId, at } fields.
function errorResult(kind, error, context, format) {
  return {
    code: ERROR_EXIT_CODES[kind],
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      error,
      kind,
      hint: errorHint(kind, error),
      ...context,
    },
    format,
  };
}

export { errorResult, ERROR_EXIT_CODES };
