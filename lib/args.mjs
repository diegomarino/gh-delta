// Shared argument parsing helpers used by the detector CLI.
const ALLOWED_ENTITIES = new Set(['pr', 'issue']);
const ENTITY_ORDER = ['pr', 'issue'];
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MONITOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  const selected = ENTITY_ORDER.filter((entity) => tokens.includes(entity));
  return {
    wantsPr,
    wantsIssue,
    selected,
    key: selected.join('-'),
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

/**
 * Validate `--repo owner/name`.
 *
 * @param {string|unknown} repo
 * @returns {{ok: boolean, repo?: string, error?: string}}
 */
export function validateRepo(repo) {
  const value = String(repo ?? '');
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPO_SEGMENT.test(parts[0]) ||
    !REPO_SEGMENT.test(parts[1])
  ) {
    return { ok: false, error: `--repo must be in owner/name form; got "${value}"` };
  }
  return { ok: true, repo: value };
}

/**
 * Validate `--monitor-id` grammar.
 *
 * The value must be a short stable token; leading/trailing dots are rejected
 * explicitly to avoid filesystem/path edge cases.
 *
 * @param {string|unknown} monitorId
 * @returns {{ok: boolean, monitorId?: string, error?: string}}
 */
export function validateMonitorId(monitorId) {
  const value = String(monitorId ?? '');
  if (!MONITOR_ID.test(value) || value === '.' || value === '..') {
    return {
      ok: false,
      error:
        '--monitor-id must start with a letter or number and contain only letters, numbers, dot, underscore, or dash',
    };
  }
  return { ok: true, monitorId: value };
}
