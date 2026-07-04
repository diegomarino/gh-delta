// Entrypoint detection shared by package bins and importable modules.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Return true when a module is the process entrypoint.
 *
 * npm and npx invoke bins through symlinks under node_modules/.bin, so real
 * paths are compared first. If realpath fails, literal equality still proves
 * direct invocation. A remaining ambiguity is reported on stderr instead of
 * silently refusing to start: a cron watcher must never look healthy while
 * doing nothing.
 */
export function isDirectEntrypoint(
  metaUrl,
  argvPath = process.argv[1],
  warn = (message) => process.stderr.write(`${message}\n`),
) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    if (modulePath === argvPath) return true;
    warn(
      `gh-delta: cannot resolve entrypoint paths (realpath failed for "${argvPath}"); not starting the CLI`,
    );
    return false;
  }
}
