import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaFor } from '../../lib/schema.mjs';

const check = process.argv.includes('--check');
const directory = resolve('schema');
if (!check) mkdirSync(directory, { recursive: true });
let drift = false;
for (const format of ['json', 'compact', 'ndjson']) {
  const path = resolve(directory, `${format}.json`);
  const bytes = `${JSON.stringify(schemaFor(format), null, 2)}\n`;
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  let matches = current === bytes;
  if (check && current !== null) {
    try {
      matches = JSON.stringify(JSON.parse(current)) === JSON.stringify(schemaFor(format));
    } catch {
      matches = false;
    }
  }
  if (!matches) {
    drift = true;
    if (!check) writeFileSync(path, bytes);
  }
}
if (check && drift) {
  process.stderr.write('Generated schema artifacts drift; run npm run schema:generate.\n');
  process.exitCode = 1;
}
