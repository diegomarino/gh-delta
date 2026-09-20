// Guards the machine-readable help contract: every flag the parser accepts
// must be documented in --help/--help-json for that command, and vice versa.
// This is command-scoped (not a flat set across the whole CLI) because two
// subcommands are free to define different flags, or the same flag with
// different meaning — a flat comparison would stop meaning anything once
// more subcommands (wait, read, status, watch, schema, ...) land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARSER_OPTIONS_BY_COMMAND } from '../lib/cli.mjs';
import { HELP_COMMAND_KEYS, getHelpSpec } from '../lib/help.mjs';

function parserFlagSet(optionsTable) {
  return new Set(Object.keys(optionsTable).map((name) => `--${name}`));
}

function helpFlagSet(command) {
  return new Set(getHelpSpec(command).options.map((option) => option.name));
}

function diff(a, b) {
  return [...a].filter((item) => !b.has(item));
}

test('registry command keys match help.mjs HELP_SPECS command keys exactly', () => {
  const registryKeys = new Set(Object.keys(PARSER_OPTIONS_BY_COMMAND));
  const helpKeys = new Set(HELP_COMMAND_KEYS);

  const missingFromRegistry = diff(helpKeys, registryKeys);
  const missingFromHelp = diff(registryKeys, helpKeys);

  assert.deepEqual(
    missingFromRegistry,
    [],
    `HELP_SPECS command(s) not registered in PARSER_OPTIONS_BY_COMMAND: ${missingFromRegistry.join(', ')}`,
  );
  assert.deepEqual(
    missingFromHelp,
    [],
    `PARSER_OPTIONS_BY_COMMAND command(s) missing a HELP_SPECS entry: ${missingFromHelp.join(', ')}`,
  );
});

for (const command of Object.keys(PARSER_OPTIONS_BY_COMMAND)) {
  test(`"${command}" parser flags match its --help option list`, () => {
    const parserFlags = parserFlagSet(PARSER_OPTIONS_BY_COMMAND[command]);
    const documentedFlags = helpFlagSet(command);

    const missingFromHelp = diff(parserFlags, documentedFlags);
    const extraInHelp = diff(documentedFlags, parserFlags);

    assert.deepEqual(
      missingFromHelp,
      [],
      `"${command}": flag(s) accepted by the parser but missing from --help: ${missingFromHelp.join(', ')}`,
    );
    assert.deepEqual(
      extraInHelp,
      [],
      `"${command}": flag(s) documented in --help but not accepted by the parser: ${extraInHelp.join(', ')}`,
    );
  });
}
