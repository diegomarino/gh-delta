// Shared argument parsing helpers used by the detector CLI.
import { createHash } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

const ALLOWED_ENTITIES = new Set(['pr', 'issue']);
const ENTITY_ORDER = ['pr', 'issue'];
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const DOT_ONLY = /^\.+$/;
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
 * Canonical snapshot-key form of an `--entities` string: known entities in
 * canonical order, deduplicated; unknown tokens pass through joined by `-`
 * so library callers get a stable (if unvalidated) key.
 */
export function canonicalEntityKey(entities) {
  const tokens = entityTokens(String(entities));
  const known = ENTITY_ORDER.filter((entity) => tokens.includes(entity));
  return (known.length ? known : tokens).join('-');
}

/**
 * Stable per-machine default for --monitor-id: `host-` + truncated sha1 of
 * the hostname. Hashing keeps machine identity out of outpost payloads and
 * always satisfies the monitor-id grammar. A hostname change (host rename,
 * container, CI runner with per-job hostnames) yields a new id and therefore
 * a fresh baseline.
 */
export function defaultMonitorId({ hostname = osHostname } = {}) {
  const digest = createHash('sha1')
    .update(String(hostname() || 'unknown'))
    .digest('hex');
  return `host-${digest.slice(0, 12)}`;
}

/**
 * Validate `--repo owner/name`.
 *
 * GitHub slugs are case-insensitive; canonicalize once here so snapshot paths,
 * report echoes, and outpost eventIds never fork on operator casing.
 *
 * @param {string|unknown} repo
 * @returns {{ok: boolean, repo?: string, error?: string}}
 */
export function validateRepo(repo) {
  // Canonicalize to lowercase for consistent snapshot paths and event IDs
  const value = String(repo ?? '').toLowerCase();
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || !REPO_SEGMENT.test(part) || DOT_ONLY.test(part))
  ) {
    return { ok: false, error: `--repo must be in owner/name form; got "${repo}"` };
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
