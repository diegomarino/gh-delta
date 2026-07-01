// Entrypoint detection shared by package bins and importable modules.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Return true when a module is the process entrypoint.
 *
 * npm and npx invoke bins through symlinks under node_modules/.bin. Comparing
 * real paths keeps direct `node file.mjs`, package bins, and test imports
 * distinguishable without starting the CLI when the module is imported.
 */
export function isDirectEntrypoint(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}
