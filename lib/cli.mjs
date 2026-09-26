// Compatibility facade for CLI consumers and executable entrypoints.
export { REPORT_SCHEMA_VERSION } from './contract.mjs';
export { PARSER_OPTIONS_BY_COMMAND } from './cli/parse.mjs';
export { parseCli } from './cli/parse.mjs';
export { enrichDelta } from './cli/delta-details.mjs';
export { run } from './cli/runner.mjs';
export { runWithOutpost } from './cli/runner.mjs';
export { runCommand } from './cli/runner.mjs';
