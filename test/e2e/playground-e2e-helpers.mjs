// Pure helpers for the live playground e2e harness.
export function parseRepoSpec(spec, defaultOwner) {
  const value = spec?.trim();
  if (!value) throw new Error('playground repo name cannot be empty');

  const parts = value.split('/');
  if (parts.length === 1) {
    if (!defaultOwner) throw new Error('plain repo names require an authenticated gh user');
    return { owner: defaultOwner, name: parts[0] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], name: parts[1] };

  throw new Error(`playground repo must be "name" or "owner/name"; got "${spec}"`);
}

export function safeRunId(value = new Date().toISOString()) {
  return value
    .replace(/[:.]/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function defaultPlaygroundRepoName(runId) {
  return `gh-delta-test-playground-${runId}`;
}

export function shouldDeletePlaygroundRepo({ createdByHarness, keepRepo }) {
  return createdByHarness && !keepRepo;
}

export function assertDeltaClass(result, entity, number, klass) {
  if (result.code !== 10) {
    throw new Error(`expected gh-delta exit 10 for ${entity} #${number}; got ${result.code}`);
  }

  const delta = result.report?.deltas?.find(
    (item) => item.entity === entity && Number(item.number) === Number(number),
  );
  if (!delta?.classes?.includes(klass)) {
    throw new Error(
      `missing expected delta ${entity} #${number} class ${klass}; got ${JSON.stringify(
        result.report?.deltas ?? [],
      )}`,
    );
  }
}

export function detectorResultFromProcess(result) {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh-delta did not print JSON: ${error.message}\n${result.stdout}`);
  }

  return { code: result.code, report };
}
