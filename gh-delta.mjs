#!/usr/bin/env node
// Public bin entrypoint. Programmatic public imports live on documented subpaths.
import { isDirectEntrypoint } from './lib/entrypoint.mjs';
import { runCommand } from './lib/cli.mjs';

if (isDirectEntrypoint(import.meta.url)) {
  const { code, output, stderr } = await runCommand(process.argv.slice(2));
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(output);
  // process.exitCode (not process.exit) lets the event loop drain stdio buffers;
  // process.exit() truncates piped output past the kernel pipe buffer.
  process.exitCode = code;
}
