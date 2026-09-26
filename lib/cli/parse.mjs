// Shared CLI grammar and parsing policies, including help/version pre-scans.
import { DELTA_CLASSES } from '../contract.mjs';
import { renderHelpText, renderHelpJson } from '../help.mjs';
import { renderVersionText } from '../version.mjs';
import { parseArgs } from 'node:util';
import { validateRepo } from '../args.mjs';
/**
 * Validate and parse a positive integer from a string.
 *
 * @param {string} name - The flag name for error messages
 * @param {string} raw - The raw string value
 * @returns {{ value: number } | { error: string }}
 */
function positiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    return { error: `${name} must be a positive integer; got "${raw}"` };
  return { value };
}

function nonNegativeSafeInt(name, raw) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw))
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  return { value };
}

function parseDeltaClassSelection(flag, raw) {
  if (raw === undefined) return { ok: true, classes: [] };
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const invalid = tokens.find((token) => !DELTA_CLASSES.includes(token));
  if (invalid) return { ok: false, error: `${flag} must name a delta class; got "${invalid}"` };
  if (tokens.length === 0)
    return { ok: false, error: `${flag} must name at least one delta class; got "${raw}"` };
  return { ok: true, classes: [...new Set(tokens)] };
}

const CLI_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  number: { type: 'string' },
  format: { type: 'string', default: 'json' },
  detail: { type: 'boolean', default: false },
  summaries: { type: 'boolean', default: false },
  enrich: { type: 'string' },
  'rate-limit-floor': { type: 'string' },
  'only-classes': { type: 'string' },
  'ignore-classes': { type: 'string' },
  'ignore-authors': { type: 'string' },
  settled: { type: 'boolean', default: false },
  'baseline-emit-state': { type: 'boolean', default: false },
  'summary-line': { type: 'boolean', default: false },
  full: { type: 'boolean', default: false },
  'outpost-url': { type: 'string' },
  'outpost-secret': { type: 'string' },
  'outpost-timeout-ms': { type: 'string', default: '4000' },
  'outpost-max-posts': { type: 'string' },
  'gh-timeout-ms': { type: 'string', default: '60000' },
  'no-registry': { type: 'boolean', default: false },
  'lock-stale-ms': { type: 'string', default: '10m' },
  'stale-after': { type: 'string' },
  log: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const READ_OPTIONS = {
  cursor: { type: 'string' },
  'only-classes': { type: 'string' },
  number: { type: 'string' },
  advance: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const CURSOR_SET_OPTIONS = {
  'log-file': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const COMPACT_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  keep: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const RESET_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  yes: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const SCHEMA_OPTIONS = {
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const STATUS_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  'state-file': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  number: { type: 'string' },
  refresh: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const INIT_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  entities: { type: 'string', default: 'pr,issue' },
  agent: { type: 'boolean', default: false },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const DOCTOR_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const EXPLAIN_OPTIONS = {
  'log-file': { type: 'string' },
  'report-file': { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const DEMO_OPTIONS = {
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const {
  'outpost-url': _waitOutpostUrl,
  'outpost-secret': _waitOutpostSecret,
  'outpost-timeout-ms': _waitOutpostTimeout,
  'outpost-max-posts': _waitOutpostMaxPosts,
  ...WAIT_DETECTOR_OPTIONS
} = CLI_OPTIONS;

const WAIT_OPTIONS = {
  ...WAIT_DETECTOR_OPTIONS,
  timeout: { type: 'string' },
  until: { type: 'string' },
  'until-summary': { type: 'string' },
  interval: { type: 'string', default: '60s' },
  'max-interval': { type: 'string' },
  backoff: { type: 'string', default: '1' },
  settle: { type: 'string' },
  'heartbeat-file': { type: 'string' },
  progress: { type: 'boolean', default: false },
  'from-log': { type: 'boolean', default: false },
  cursor: { type: 'string' },
};

// Help must be indestructible: an agent probing with --help-json gets the help
// document even when the rest of the command is invalid. Literal pre-scan, no parsing.
function helpRequest(argv) {
  if (argv.includes('--help')) return renderHelpText('gh-delta');
  if (argv.includes('--help-json')) return renderHelpJson('gh-delta');
  if (argv.includes('--version')) return renderVersionText();
  return null;
}

// Tolerant --format sniff used ONLY to render errors when strict parsing failed.
function formatSniff(argv) {
  let format = 'json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format' && argv[i + 1]) format = argv[i + 1];
    else if (argv[i].startsWith('--format=')) format = argv[i].slice('--format='.length);
  }
  return ['text', 'compact', 'ndjson'].includes(format) ? format : 'json';
}

/**
 * One strict parse for the whole CLI. Repeated flags: last value wins.
 *
 * Returns `{ help }` when a help/version flag is detected (pre-scan, no parse),
 * `{ error, format }` on a parse failure, or `{ values, format }` on success.
 *
 * @param {string[]} argv
 * @returns {{ help?: string, error?: string, values?: object, format: string }}
 */
function parseCli(argv) {
  const help = helpRequest(argv);
  if (help) return { help, format: 'json' };
  try {
    const { values } = parseArgs({ args: argv, options: CLI_OPTIONS });
    return { values, format: values.format };
  } catch (err) {
    return { error: String(err?.message ?? err), format: formatSniff(argv) };
  }
}

const LIST_OPTIONS = {
  'state-dir': { type: 'string' },
  since: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

const WATCH_OPTIONS = {
  repo: { type: 'string' },
  'monitor-id': { type: 'string' },
  'state-dir': { type: 'string' },
  'watch-dir': { type: 'string' },
  until: { type: 'string' },
  format: { type: 'string', default: 'json' },
  help: { type: 'boolean', default: false },
  'help-json': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
};

// Command-scoped map from a help-spec command key (see HELP_SPECS in
// help.mjs) to the parser option table that backs it. Deliberately NOT a
// flat set of all flags across the whole CLI: once subcommands multiply
// (wait, read, status, watch, schema, ...) a flat comparison stops meaning
// anything, since two subcommands are free to define the same flag name
// with different semantics or not define it at all. Every new subcommand
// MUST add its own entry here alongside its HELP_SPECS entry — this map,
// together with the sync test in test/help-options-sync.test.mjs, is what
// enforces that the parser and --help never drift apart per command.
const PARSER_OPTIONS_BY_COMMAND = Object.freeze({
  'gh-delta': CLI_OPTIONS,
  'gh-delta list': LIST_OPTIONS,
  'gh-delta watch add': WATCH_OPTIONS,
  'gh-delta watch rm': Object.fromEntries(
    Object.entries(WATCH_OPTIONS).filter(([name]) => name !== 'until'),
  ),
  'gh-delta watch ls': Object.fromEntries(
    Object.entries(WATCH_OPTIONS).filter(([name]) => name !== 'until'),
  ),
  'gh-delta read': READ_OPTIONS,
  'gh-delta cursor set': CURSOR_SET_OPTIONS,
  'gh-delta log compact': COMPACT_OPTIONS,
  'gh-delta reset': RESET_OPTIONS,
  'gh-delta schema': SCHEMA_OPTIONS,
  'gh-delta status': STATUS_OPTIONS,
  'gh-delta wait': WAIT_OPTIONS,
  'gh-delta init': INIT_OPTIONS,
  'gh-delta doctor': DOCTOR_OPTIONS,
  'gh-delta explain': EXPLAIN_OPTIONS,
  'gh-delta demo': DEMO_OPTIONS,
});

function watchNumbers(raw) {
  if (raw === undefined) return { ok: true, numbers: null };
  const values = String(raw)
    .split(',')
    .map((x) => Number(x.trim()));
  return values.length && values.every((n) => Number.isSafeInteger(n) && n > 0)
    ? { ok: true, numbers: new Set(values) }
    : { ok: false, error: '--number must be comma-separated positive safe integers' };
}

function nonNegativeInt(name, raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    return { error: `${name} must be a non-negative safe integer; got "${raw}"` };
  return { value };
}

function commandHelp(argv, command) {
  if (argv.includes('--help')) return renderHelpText(command);
  if (argv.includes('--help-json')) return renderHelpJson(command);
  if (argv.includes('--version')) return renderVersionText();
  return null;
}

// Keep `run` as the public entrypoint.  The historical implementation above is
// deliberately kept as one complete, private repository tick: calling it once
// is therefore byte-for-byte the old path, while the small wrapper below can
// serialize several independent ticks without ever holding several locks.
function explicitRepos(argv) {
  const values = [];
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--repo') {
      if (index + 1 >= argv.length) return { malformed: true };
      values.push(argv[++index]);
    } else if (arg.startsWith('--repo=')) {
      values.push(arg.slice('--repo='.length));
    } else {
      rest.push(arg);
    }
  }
  if (!values.length) return { repos: [], rest: argv };
  const repos = [];
  for (const value of values) {
    for (const member of String(value).split(',')) {
      const candidate = member.trim();
      if (!candidate)
        return {
          error: `--repo must be a comma-separated list of owner/name values; got "${value}"`,
        };
      const validated = validateRepo(candidate);
      if (!validated.ok) return { error: validated.error };
      if (!repos.includes(validated.repo)) repos.push(validated.repo);
    }
  }
  return { repos, rest };
}

export {
  commandHelp,
  READ_OPTIONS,
  formatSniff,
  parseDeltaClassSelection,
  positiveInt,
  CURSOR_SET_OPTIONS,
  nonNegativeInt,
  INIT_OPTIONS,
  DOCTOR_OPTIONS,
  EXPLAIN_OPTIONS,
  DEMO_OPTIONS,
  COMPACT_OPTIONS,
  RESET_OPTIONS,
  WATCH_OPTIONS,
  LIST_OPTIONS,
  STATUS_OPTIONS,
  watchNumbers,
  SCHEMA_OPTIONS,
  WAIT_OPTIONS,
  explicitRepos,
  parseCli,
  nonNegativeSafeInt,
  PARSER_OPTIONS_BY_COMMAND,
};
