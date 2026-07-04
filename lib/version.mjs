// Package metadata helpers for CLI version output.
import { readFileSync } from 'node:fs';

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

let cachedMetadata;

/**
 * Load package metadata from package.json and cache it for the process.
 *
 * Caching avoids repeated fs reads across multiple CLI paths in the same run.
 */
export function getPackageMetadata() {
  if (!cachedMetadata) {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
    cachedMetadata = {
      name: pkg.name,
      version: pkg.version,
    };
  }
  return { ...cachedMetadata };
}

/**
 * Return printable version output for CLI `--version`.
 */
export function renderVersionText(metadata = getPackageMetadata()) {
  return `${metadata.name} ${metadata.version}\n`;
}
