// Shared argument parsing helpers used by the detector CLI and tick wrapper.
const ALLOWED_ENTITIES = new Set(['pr', 'issue']);

function entityTokens(entities) {
  return entities
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Parse the `--entities` value into fetch booleans and validation state.
 *
 * Accepted values are `pr`, `issue`, or any comma-separated combination of the
 * two. Empty or unknown selections are invalid and should fail before GitHub is
 * fetched or snapshots are touched.
 */
export function parseEntitySelection(entities) {
  const tokens = entityTokens(entities);
  const invalid = tokens.filter((token) => !ALLOWED_ENTITIES.has(token));
  const wantsPr = tokens.includes('pr');
  const wantsIssue = tokens.includes('issue');
  return {
    wantsPr,
    wantsIssue,
    invalid,
    ok: invalid.length === 0 && (wantsPr || wantsIssue),
  };
}

/**
 * Remove the optional outpost flag from argv while preserving detector args.
 *
 * The detector parser intentionally does not know about outposts; this helper
 * keeps outpost handling consistent between JSON and tick modes.
 */
export function parseOutpostArgs(argv) {
  const detectorArgs = [];
  let outpostUrl;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outpost-url') {
      if (outpostUrl !== undefined) {
        return { error: '--outpost-url may only be provided once' };
      }
      const value = argv[i + 1];
      if (value === undefined) return { error: '--outpost-url requires a URL' };
      outpostUrl = value;
      i++;
      continue;
    }
    if (arg.startsWith('--outpost-url=')) {
      if (outpostUrl !== undefined) {
        return { error: '--outpost-url may only be provided once' };
      }
      outpostUrl = arg.slice('--outpost-url='.length);
      continue;
    }
    detectorArgs.push(arg);
  }
  return { detectorArgs, outpostUrl };
}
