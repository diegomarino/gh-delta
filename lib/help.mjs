// Shared CLI help metadata and renderers for human and machine-readable output.
import { getPackageMetadata } from './version.mjs';

export const HELP_SCHEMA_VERSION = 1;
const PACKAGE_METADATA = getPackageMetadata();

const OPTION_REPO = {
  name: '--repo',
  valueName: 'owner/name',
  type: 'string',
  required: true,
  description: 'GitHub repository in owner/name form.',
};

const OPTION_MONITOR_ID = {
  name: '--monitor-id',
  valueName: 'id',
  type: 'string',
  required: true,
  description: 'Stable monitor identity used in reports, event IDs, and derived snapshot paths.',
};

const OPTION_STATE_FILE = {
  name: '--state-file',
  valueName: 'path',
  type: 'string',
  required: false,
  description: 'Explicit snapshot JSON path. Mutually exclusive with --state-dir.',
};

const OPTION_STATE_DIR = {
  name: '--state-dir',
  valueName: 'dir',
  type: 'string',
  required: false,
  description:
    'Directory for a derived snapshot path scoped by repo, monitor id, and selected entities.',
};

const OPTION_ENTITIES = {
  name: '--entities',
  valueName: 'pr,issue',
  type: 'string',
  required: false,
  default: 'pr,issue',
  allowedValues: ['pr', 'issue', 'pr,issue'],
  grammar: 'comma-separated unique values from: pr, issue; input order is canonicalized',
  description: 'Comma-separated entity list: pr, issue, or pr,issue.',
};

const OPTION_FORMAT = {
  name: '--format',
  valueName: 'json|text',
  type: 'string',
  required: false,
  default: 'json',
  allowedValues: ['json', 'text'],
  description: 'Output format: json for programs, text for operators and scheduled logs.',
};

const OPTION_OUTPOST_URL = {
  name: '--outpost-url',
  valueName: 'url',
  type: 'string',
  required: false,
  description: 'Send one fire-and-forget HTTP POST per delta when exit code is 10.',
};

const HELP_OPTIONS = [
  {
    name: '--help',
    type: 'boolean',
    required: false,
    description: 'Show human-readable help.',
  },
  {
    name: '--help-json',
    type: 'boolean',
    required: false,
    description: 'Print this machine-readable help document as JSON.',
  },
  {
    name: '--version',
    type: 'boolean',
    required: false,
    description: 'Print package version.',
  },
];

const EXIT_CODES = [
  { code: 0, meaning: 'Baseline established or no deltas.' },
  { code: 10, meaning: 'Deltas found.' },
  {
    code: 1,
    meaning:
      'Transient error: GitHub CLI, network, timeout, or snapshot write. Retry next tick; snapshot not updated.',
  },
  {
    code: 2,
    meaning:
      'Permanent error: invalid arguments/configuration or unreadable snapshot. Fix before retrying; snapshot not updated.',
  },
];

const HELP_SPECS = {
  'gh-delta': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta',
    version: PACKAGE_METADATA.version,
    summary: 'Deterministic GitHub issue and pull request delta detector.',
    usage:
      'gh-delta --repo <owner/name> --monitor-id <id> (--state-dir <dir> | --state-file <path>) [--entities pr,issue] [--format json|text] [--detail] [--outpost-url <url>]',
    purpose:
      'Run one deterministic detection pass, update the snapshot after a successful fetch, print JSON or operator text, and exit. Scheduling belongs to the caller.',
    options: [
      OPTION_REPO,
      OPTION_MONITOR_ID,
      OPTION_STATE_FILE,
      OPTION_STATE_DIR,
      OPTION_ENTITIES,
      OPTION_FORMAT,
      {
        name: '--detail',
        type: 'boolean',
        required: false,
        description: 'Add one human-readable line per delta in JSON output.',
      },
      OPTION_OUTPOST_URL,
      ...HELP_OPTIONS,
    ],
    output: {
      formats: ['json', 'text'],
      stream: 'stdout',
      schema: 'detector-report-v1',
      description:
        'JSON output contains schemaVersion, baseline, repo, monitorId, entities, at, deltas, and summary fields; error output is schemaVersion, error, at, and optional repo and monitorId. Text output contains an operator heartbeat and suggested actions.',
    },
    exitCodes: EXIT_CODES,
    safety: [
      'Snapshot writes are atomic.',
      'The snapshot is not updated on GitHub CLI, network, parse, or argument errors.',
      'Outpost delivery warnings do not change the detector exit code.',
    ],
    examples: [
      {
        description: 'Seed or check a repository snapshot.',
        command: 'gh-delta --repo owner/repo --monitor-id prs --state-dir .gh-delta --entities pr',
      },
      {
        description: 'Run a scheduled monitor tick with readable logs.',
        command:
          'gh-delta --repo owner/repo --monitor-id prs --state-dir .gh-delta --entities pr --format text',
      },
      {
        description: 'Print machine-readable help for agents and tooling.',
        command: 'gh-delta --help-json',
      },
      {
        description: 'Print the package version.',
        command: 'gh-delta --version',
      },
    ],
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build the user-facing option label string.
 *
 * Boolean flags remain bare, while value-taking flags include a placeholder.
 */
function optionLabel(option) {
  return option.valueName ? `${option.name} <${option.valueName}>` : option.name;
}

/**
 * Render an aligned CLI option table for human-readable help output.
 */
function renderOptions(options) {
  const width = Math.max(...options.map((option) => optionLabel(option).length)) + 2;
  return options
    .map((option) => `  ${optionLabel(option).padEnd(width)}${option.description}`)
    .join('\n');
}

/**
 * Render exit code meanings as a plain-text two-column block.
 */
function renderExitCodes(exitCodes) {
  return exitCodes.map((entry) => `  ${String(entry.code).padEnd(3)} ${entry.meaning}`).join('\n');
}

/**
 * Return structured help metadata for a supported command.
 *
 * Callers receive a copy so consumers can sort or annotate the object without
 * mutating the canonical CLI help used by the renderers.
 */
export function getHelpSpec(command) {
  const spec = HELP_SPECS[command];
  if (!spec) throw new Error(`unknown help command: ${command}`);
  return clone(spec);
}

/**
 * Render the command help intended for humans.
 */
export function renderHelpText(command) {
  const spec = getHelpSpec(command);
  const sections = [
    `Usage:\n  ${spec.usage}`,
    spec.purpose,
    `Options:\n${renderOptions(spec.options)}`,
    `Exit codes:\n${renderExitCodes(spec.exitCodes)}`,
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/**
 * Render the command help intended for LLMs, agents, and other tools.
 */
export function renderHelpJson(command) {
  return `${JSON.stringify(getHelpSpec(command), null, 2)}\n`;
}
