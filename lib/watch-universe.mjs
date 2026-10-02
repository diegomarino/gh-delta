// Targeted-watch snapshot identity. PR-only lists, including a strict
// `pr,issue` selection that does not yet contain an issue, keep the historical
// `watch-pr` universe. Issue-only and mixed-with-issues lists are separate
// universes and therefore a fresh baseline; nothing here deletes the old file.

export const WATCH_SCOPES = Object.freeze(['watch-pr', 'watch-issue', 'watch-pr-issue']);

const SCOPE_ENTITIES = {
  'watch-pr': ['pr'],
  'watch-issue': ['issue'],
  'watch-pr-issue': ['pr', 'issue'],
};

/**
 * Reject a watch entry that cannot be observed under this strict selection.
 * Mixed `pr,issue` accepts both. A message is returned only for a real mismatch.
 *
 * @param {{ wantsPr: boolean, wantsIssue: boolean }} selection
 * @param {string} entity
 * @returns {string | null}
 */
export function strictEntryError(selection, entity) {
  if (selection.wantsPr && !selection.wantsIssue && entity === 'issue')
    return '--watch-strict cannot include issue watch entries';
  if (selection.wantsIssue && !selection.wantsPr && entity === 'pr')
    return '--watch-strict cannot include pr watch entries';
  return null;
}

/**
 * Choose the targeted snapshot universe for one repository's applicable entries.
 * Non-strict mode is unchanged: only a 0-10 PR-only list is targeted.
 *
 * @param {{ wantsPr: boolean, wantsIssue: boolean, selected: string[] }} selection
 * @param {{ entity: string }[]} watches
 * @param {{ strict?: boolean }} [options]
 */
export function resolveWatchUniverse(selection, watches, { strict = false } = {}) {
  if (strict) {
    for (const entry of watches) {
      const error = strictEntryError(selection, entry.entity);
      if (error) return { ok: false, error };
    }
    const hasIssue = watches.some((entry) => entry.entity === 'issue');
    const scope =
      selection.wantsIssue && !selection.wantsPr
        ? 'watch-issue'
        : hasIssue
          ? 'watch-pr-issue'
          : 'watch-pr';
    return { ok: true, targeted: true, scope, entities: SCOPE_ENTITIES[scope] };
  }
  const targeted =
    selection.wantsPr && watches.every((entry) => entry.entity === 'pr') && watches.length <= 10;
  if (!targeted) return { ok: true, targeted: false, scope: null, entities: selection.selected };
  return { ok: true, targeted: true, scope: 'watch-pr', entities: ['pr'] };
}

/**
 * Strict snapshot scopes `reset --state-dir` may delete for this selection.
 * `pr,issue` still includes historical `watch-pr` and does not include
 * `watch-issue`, which belongs to the issue-only selection.
 *
 * @param {{ wantsPr: boolean, wantsIssue: boolean }} selection
 * @returns {string[]}
 */
export function strictResetScopes(selection) {
  const scopes = [];
  if (selection.wantsPr) scopes.push('watch-pr');
  if (selection.wantsIssue && !selection.wantsPr) scopes.push('watch-issue');
  if (selection.wantsPr && selection.wantsIssue) scopes.push('watch-pr-issue');
  return scopes;
}
