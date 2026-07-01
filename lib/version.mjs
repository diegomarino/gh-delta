// Package metadata helpers for CLI version output.
import { readFileSync } from 'node:fs';

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

let cachedMetadata;

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

export function renderVersionText(metadata = getPackageMetadata()) {
  return `${metadata.name} ${metadata.version}\n`;
}
