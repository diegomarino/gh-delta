// Shared CLI help metadata and renderers for human and machine-readable output.
export const HELP_SCHEMA_VERSION = 1;

const COMMON_DETECTOR_OPTIONS = [
  {
    name: '--repo',
    valueName: 'owner/name',
    type: 'string',
    required: true,
    description: 'GitHub repository in owner/name form.',
  },
  {
    name: '--state-file',
    valueName: 'path',
    type: 'string',
    required: true,
    description: 'Snapshot JSON path.',
  },
  {
    name: '--branch',
    valueName: 'name',
    type: 'string',
    required: false,
    description: 'Branch or watch-loop name to include in reports.',
  },
  {
    name: '--entities',
    valueName: 'pr,issue',
    type: 'string',
    required: false,
    default: 'pr,issue',
    allowedValues: ['pr', 'issue', 'pr,issue'],
    description: 'Comma-separated entity list: pr, issue, or pr,issue.',
  },
  {
    name: '--outpost-url',
    valueName: 'url',
    type: 'string',
    required: false,
    description: 'Send one fire-and-forget HTTP POST per delta when exit code is 10.',
  },
];

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
];

const EXIT_CODES = [
  { code: 0, meaning: 'Baseline established or no deltas.' },
  { code: 10, meaning: 'Deltas found.' },
  {
    code: 1,
    meaning: 'GitHub CLI, network, parse, or argument error. Snapshot is not updated on errors.',
  },
];

const HELP_SPECS = {
  'gh-delta': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta',
    summary: 'Deterministic GitHub issue and pull request delta detector.',
    usage:
      'gh-delta --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--detail] [--outpost-url <url>]',
    purpose:
      'Fetch current GitHub pull request and issue state, compare it with a local snapshot, update the snapshot after a successful read, and report factual deltas.',
    options: [
      ...COMMON_DETECTOR_OPTIONS.slice(0, 4),
      {
        name: '--detail',
        type: 'boolean',
        required: false,
        description: 'Add one human-readable line per delta.',
      },
      COMMON_DETECTOR_OPTIONS[4],
      ...HELP_OPTIONS,
    ],
    output: {
      format: 'json',
      stream: 'stdout',
      schema: 'detector-report-v1',
      description:
        'On normal runs stdout is a JSON report with baseline, repo, branch, at, deltas, and summary fields.',
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
        command: 'gh-delta --repo owner/repo --state-file .gh-delta/main.json --branch main',
      },
      {
        description: 'Print machine-readable help for agents and tooling.',
        command: 'gh-delta --help-json',
      },
    ],
  },
  'gh-delta-tick': {
    helpSchemaVersion: HELP_SCHEMA_VERSION,
    command: 'gh-delta-tick',
    summary: 'One-shot scheduler tick wrapper for gh-delta.',
    usage:
      'gh-delta-tick --repo <owner/name> --state-file <path> [--branch <name>] [--entities pr,issue] [--outpost-url <url>]',
    purpose:
      'Run one scheduler-owned watcher tick, format heartbeat text and suggested actions, then exit.',
    options: [...COMMON_DETECTOR_OPTIONS, ...HELP_OPTIONS],
    output: {
      format: 'text',
      stream: 'stdout',
      description:
        'Stdout is operator-friendly heartbeat text with delta labels, classes, and suggested next actions.',
    },
    exitCodes: EXIT_CODES,
    safety: [
      'It never creates timers, cron jobs, automations, or wake-ups.',
      'The detector still owns snapshot safety and error handling.',
      'Outpost delivery warnings do not change the detector exit code.',
    ],
    examples: [
      {
        description: 'Run one watch-loop tick.',
        command: 'gh-delta-tick --repo owner/repo --state-file .gh-delta/watch.json --branch watch',
      },
      {
        description: 'Print machine-readable help for agents and tooling.',
        command: 'gh-delta-tick --help-json',
      },
    ],
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function optionLabel(option) {
  return option.valueName ? `${option.name} <${option.valueName}>` : option.name;
}

function renderOptions(options) {
  const width = Math.max(...options.map((option) => optionLabel(option).length)) + 2;
  return options
    .map((option) => `  ${optionLabel(option).padEnd(width)}${option.description}`)
    .join('\n');
}

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
