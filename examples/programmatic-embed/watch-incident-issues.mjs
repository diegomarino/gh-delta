#!/usr/bin/env node
// Watch ONLY issues carrying a given label -- a scope the gh-delta CLI cannot
// express. Demonstrates the published library surface: pure detection over a
// custom fetch, with the CLI's snapshot and contract guarantees intact.
//
// From this repo checkout the imports are relative. From the published
// package they are:
//   import { detectDeltas } from 'gh-delta/detect';
//   import {
//     readSnapshot,
//     snapshotPath,
//     writeSnapshotAtomic,
//     SNAPSHOT_SCHEMA_VERSION,
//   } from 'gh-delta/snapshot';
//   import { DELTA_CLASSES, REPORT_SCHEMA_VERSION } from 'gh-delta/contract';
//   import { getPackageMetadata } from 'gh-delta/version';
import { execFileSync } from 'node:child_process';
import { detectDeltas } from '../../lib/detect.mjs';
import {
  readSnapshot,
  snapshotPath,
  writeSnapshotAtomic,
  SNAPSHOT_SCHEMA_VERSION,
} from '../../lib/snapshot.mjs';
import { DELTA_CLASSES, REPORT_SCHEMA_VERSION } from '../../lib/contract.mjs';
import { getPackageMetadata } from '../../lib/version.mjs';

const repo = (process.argv[2] ?? '').toLowerCase();
const label = process.argv[3] ?? 'incident';
if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
  console.error('usage: watch-incident-issues.mjs <owner/name> [label]');
  process.exit(2);
}

// REST rows -> the detector's issue row shape (the same shape the CLI's
// fetcher produces; see the mapping table in README.md).
function toDetectorRow(rest) {
  return {
    number: rest.number,
    title: rest.title,
    state: rest.state, // REST already uses v2's lowercase 'open'/'closed'
    updatedAt: rest.updated_at, // snake_case -> camelCase
    labels: rest.labels.map((restLabel) => ({ name: restLabel.name })),
    conversationComments: rest.comments, // REST exposes the exact count directly
  };
}

// One page (100) is plenty for a labelled slice; this example deliberately
// skips pagination. execFileSync blocks -- fine for a one-shot script.
const raw = execFileSync(
  'gh',
  ['api', `repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`],
  { encoding: 'utf8', timeout: 60000 },
);
// The REST issues list includes PRs; drop them.
const rows = JSON.parse(raw)
  .filter((rest) => !rest.pull_request)
  .map(toDetectorRow);

const monitorId = `incident-${label}`;
const stateFile = snapshotPath(repo, monitorId, 'issue', './state');
const old = readSnapshot(stateFile);
const at = new Date().toISOString();
const { baseline, deltas, snapshot } = detectDeltas(old, { issue: rows }, { at });
writeSnapshotAtomic(stateFile, {
  ...snapshot,
  meta: {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ghDeltaVersion: getPackageMetadata().version,
    repo,
    monitorId,
    entities: ['issue'],
    scope: 'poll',
    horizon: at,
    createdAt: old?.meta?.createdAt ?? at,
    updatedAt: at,
  },
});

for (const delta of deltas) {
  const unknown = delta.classes.filter((cls) => !DELTA_CLASSES.includes(cls));
  if (unknown.length) {
    // Forward-compat clause: unknown classes mean "inspect", never an error.
    console.error(
      `note: classes not in schema v${REPORT_SCHEMA_VERSION} set: ${unknown.join(',')}`,
    );
  }
  console.log(`ISSUE #${delta.number} "${delta.context.title}": ${delta.classes.join(', ')}`);
}
if (baseline) console.log(`baseline seeded: ${rows.length} '${label}' issue(s) tracked`);
process.exitCode = baseline || deltas.length === 0 ? 0 : 10;
