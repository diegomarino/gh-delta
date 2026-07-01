const ALLOWED_ENTITIES = new Set(['pr', 'issue']);

function entityTokens(entities) {
  return entities
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

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

// Shared by both CLIs so outpost handling cannot drift between JSON and tick modes.
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
