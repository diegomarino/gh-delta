import { validateRepo } from './args.mjs';
import { canonicalLabels } from './watch-entry.mjs';
import { parseWatchItem } from './watch.mjs';

function fail(message) {
  throw new Error(message.startsWith('watch sync') ? message : `watch sync: ${message}`);
}

function wrap(fn) {
  try {
    return fn();
  } catch (err) {
    fail(err.message);
  }
}

function significantLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && trimmed[0] !== '#';
    })
    .map((line) => line.trim());
}

function parseRecord(line, defaultRepo) {
  const tokens = line.split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0) fail('empty record');
  const item = wrap(() => parseWatchItem(tokens[0]));
  let until;
  let repoToken;
  const labels = Object.create(null);
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf('=');
    if (eq <= 0 || token.indexOf('=', eq + 1) !== -1) fail(`invalid token ${token}`);
    if (/^until=(merged|closed)$/.test(token)) {
      if (until !== undefined) fail('duplicate until');
      until = token.slice('until='.length);
      continue;
    }
    if (token.startsWith('repo=')) {
      if (repoToken !== undefined) fail('duplicate repo');
      repoToken = token.slice('repo='.length);
      continue;
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (Object.hasOwn(labels, key)) fail(`duplicate label key ${key}`);
    labels[key] = value;
  }
  if (until === undefined) fail('until is required');
  if (item.entity === 'issue' && until !== 'closed') fail('issues accept only until=closed');
  const entry = { entity: item.entity, number: item.number, until };
  const scoped = repoToken !== undefined ? repoToken : defaultRepo;
  if (scoped !== undefined) {
    const checked = validateRepo(scoped);
    if (!checked.ok) fail(checked.error);
    entry.repo = checked.repo;
  }
  if (Object.keys(labels).length > 0) entry.labels = wrap(() => canonicalLabels(labels));
  return entry;
}

export function parseWatchSync(text, { repo, allowEmpty } = {}) {
  const lines = significantLines(text);
  if (lines.length === 0) fail('missing end record');
  const endLine = lines.at(-1);
  const endMatch = /^end (\d+)$/.exec(endLine);
  if (!endMatch) fail('last record must be end N');
  const count = Number(endMatch[1]);
  if (!Number.isSafeInteger(count) || count < 0) fail('invalid end count');
  for (const line of lines.slice(0, -1)) {
    if (/^end \d+$/.test(line)) fail('duplicate end record');
  }
  const records = lines.slice(0, -1);
  if (records.length !== count) fail('end count does not match entries');
  if (count === 0 && allowEmpty !== true) fail('watch sync: empty set requires --allow-empty');
  const entries = [];
  const identities = new Set();
  const unscopedItems = new Set();
  const scopedItems = new Set();
  for (const line of records) {
    const entry = parseRecord(line, repo);
    const item = `${entry.entity}:${entry.number}`;
    const identity = `${entry.repo ?? ''}:${item}`;
    if (identities.has(identity)) fail(`duplicate identity ${item}`);
    if (entry.repo === undefined) {
      if (scopedItems.has(item)) fail(`unscoped identity overlaps ${item}`);
      unscopedItems.add(item);
    } else {
      if (unscopedItems.has(item)) fail(`scoped identity overlaps ${item}`);
      scopedItems.add(item);
    }
    identities.add(identity);
    entries.push(entry);
  }
  return { entries };
}
