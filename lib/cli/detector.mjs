// One synchronous repository transaction; preserve publication and lock-release ordering.
import {
  fetchPRs as ghPRs,
  fetchPRsByNumber as ghPRsByNumber,
  fetchIssues as ghIssues,
  fetchEnrichment as ghEnrichment,
  fetchThreadReplies as ghThreadReplies,
  fetchRateLimit as ghRateLimit,
} from '../gh.mjs';
import {
  readSnapshot as fsRead,
  writeSnapshotAtomic as fsWrite,
  economicalSnapshotPath,
  defaultStateDir,
  snapshotPath,
  horizonCutoff,
  SNAPSHOT_SCHEMA_VERSION,
} from '../snapshot.mjs';
import {
  acquireLock as fsAcquireLock,
  releaseLock as fsReleaseLock,
  assertLockOwned as fsAssertLockOwned,
  extendLockDeadline as fsExtendLockDeadline,
} from '../lock.mjs';
import {
  registerMonitor as fsRegisterMonitor,
  readRegistry as fsReadRegistry,
  defaultMachineId,
  defaultRegistryDir,
} from '../registry.mjs';
import {
  defaultMonitorId,
  validateMonitorId,
  parseEntitySelection,
  parseIgnoreAuthors,
  parseEnrichmentSelection,
  validateRepo,
} from '../args.mjs';
import { appendDeltaLog as fsAppendDeltaLog, deltaLogPath } from '../deltalog.mjs';
import { resolveRepoFromGit } from '../repo-source.mjs';
import { removeWatchUnchanged } from '../watch.mjs';
import { captureWatchFiles, watchFilename } from '../watch-entry.mjs';
import {
  withTerminalMarkLocks,
  writeTerminalIgnoredLocked,
  withWatchDirLock,
} from '../watch-lock.mjs';
import {
  markManifestTerminalIgnoredUnlocked,
  readWatchGeneration,
  readWatchGenerationUnlocked,
  removeManifestEntries,
} from '../watch-sync.mjs';
import { admitBatch, prBatches } from '../watch-batches.mjs';
import {
  parseCli,
  positiveInt,
  nonNegativeSafeInt,
  watchNumbers,
  parseDeltaClassSelection,
} from './parse.mjs';
import { errorResult } from './errors.mjs';
import { parseDuration } from '../duration.mjs';
import { selectedMonitorId, envDisablesRegistry, configDeps } from './config.mjs';
import { resolveCompiledTemplate } from './template-source.mjs';
import { validateOutpostUrl } from '../outpost.mjs';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { detectDeltas, threadReplyIncrements } from '../detect.mjs';
import { deltaId, deltaIdentity } from '../fingerprint.mjs';
import { enrichDelta, fpOf } from './delta-details.mjs';
import {
  applyAttentionFilters,
  watchedTerminalTransitionSuppressed,
  authorsIgnored,
  isTerminalCleanupEligible,
} from './attention.mjs';
import { getPackageMetadata } from '../version.mjs';
import { enrichEmittedDeltas } from '../enrich.mjs';
import { REPORT_SCHEMA_VERSION } from '../contract.mjs';
import { assertTemplateDeltas } from '../template.mjs';
// Sum `cost` across every GraphQL call this tick made (observation fetches
// plus enrichment); keep the last observed `remaining`/`resetAt`. Mirrors
// lib/gh.mjs's and lib/enrich.mjs's own accumulators, one level up.
function accumulateTickRateLimit(a, b) {
  if (!b) return a;
  if (!a) return b;
  return { cost: a.cost + b.cost, remaining: b.remaining, resetAt: b.resetAt };
}

function runDetector(argv, deps = {}) {
  const {
    fetchPRs = ghPRs,
    fetchPRsByNumber = ghPRsByNumber,
    fetchIssues = ghIssues,
    fetchEnrichment = ghEnrichment,
    fetchThreadReplies: fetchThreadRepliesGh = ghThreadReplies,
    fetchRateLimit = ghRateLimit,
    readSnapshot = fsRead,
    writeSnapshotAtomic = fsWrite,
    acquireLock = fsAcquireLock,
    releaseLock = fsReleaseLock,
    assertLockOwned = fsAssertLockOwned,
    extendLockDeadline = fsExtendLockDeadline,
    lockNow = () => Date.now(),
    lockFs,
    registerMonitor = fsRegisterMonitor,
    readRegistry = fsReadRegistry,
    defaultMonitor = defaultMonitorId,
    machineId = defaultMachineId(),
    appendDeltaLog = fsAppendDeltaLog,
    now = () => new Date().toISOString(),
    env = process.env,
    resolveRepo = resolveRepoFromGit,
    removeWatchUnchanged: removeWatchedFile = removeWatchUnchanged,
    withTerminalMarkLocks: withWatchTerminalMarkLocks = withTerminalMarkLocks,
    writeTerminalIgnoredLocked: writeWatchTerminalIgnoredLocked = writeTerminalIgnoredLocked,
    readWatchGeneration: loadWatchGeneration = readWatchGeneration,
  } = deps;
  const at = now();
  const parsed = parseCli(argv);
  if (parsed.help) return { code: 0, report: parsed.help, format: 'json' };
  if (parsed.error) return errorResult('config', parsed.error, { at }, parsed.format);
  const values = parsed.values;
  const format = parsed.format;
  const ghTimeoutMs = positiveInt('--gh-timeout-ms', values['gh-timeout-ms']);
  if (ghTimeoutMs.error) return errorResult('config', ghTimeoutMs.error, { at }, format);
  const rateLimitFloor =
    values['rate-limit-floor'] === undefined
      ? null
      : nonNegativeSafeInt('--rate-limit-floor', values['rate-limit-floor']);
  if (rateLimitFloor?.error) return errorResult('config', rateLimitFloor.error, { at }, format);
  const lockStaleMs = parseDuration(values['lock-stale-ms'], { flag: '--lock-stale-ms' });
  if (lockStaleMs.error) return errorResult('config', lockStaleMs.error, { at }, format);
  const staleAfter = values['stale-after']
    ? parseDuration(values['stale-after'], { flag: '--stale-after' })
    : null;
  if (staleAfter?.error) return errorResult('config', staleAfter.error, { at }, format);
  // Everything below, up to and including --outpost-max-posts, is repo-
  // INDEPENDENT config validation. It must run before repo derivation
  // (resolveRepo, below) because that can shell out to `gh` -- a network call.
  // A deterministic local config error must always be reported before any
  // GitHub access is attempted, whether the repo came from --repo or from
  // derivation.
  const monitorId = selectedMonitorId(values, env, defaultMonitor);
  const monitorValidation = validateMonitorId(monitorId);
  if (!monitorValidation.ok)
    return errorResult('config', monitorValidation.error, { monitorId, at }, format);
  if (values['state-file'] && values['state-dir'])
    return errorResult(
      'config',
      '--state-file and --state-dir are mutually exclusive',
      { monitorId, at },
      format,
    );
  const entitySelection = parseEntitySelection(values.entities);
  if (!entitySelection.ok)
    return errorResult(
      'config',
      `--entities must include pr, issue, or both; got "${values.entities}"`,
      { monitorId, at },
      format,
    );
  if (values['watch-dir'] !== undefined && values.number !== undefined)
    return errorResult(
      'config',
      '--watch-dir and --number are mutually exclusive',
      { monitorId, at },
      format,
    );
  const numberSelection = watchNumbers(values.number);
  if (!numberSelection.ok)
    return errorResult('config', numberSelection.error, { monitorId, at }, format);
  const onlyClasses = parseDeltaClassSelection('--only-classes', values['only-classes']);
  if (!onlyClasses.ok) return errorResult('config', onlyClasses.error, { monitorId, at }, format);
  const ignoreClasses = parseDeltaClassSelection('--ignore-classes', values['ignore-classes']);
  if (!ignoreClasses.ok)
    return errorResult('config', ignoreClasses.error, { monitorId, at }, format);
  const ignoreAuthors = parseIgnoreAuthors(values['ignore-authors']);
  if (!ignoreAuthors.ok)
    return errorResult('config', ignoreAuthors.error, { monitorId, at }, format);
  const enrichmentSelection = parseEnrichmentSelection(values.enrich);
  if (!enrichmentSelection.ok)
    return errorResult('config', enrichmentSelection.error, { monitorId, at }, format);
  const attentionFiltering =
    values['only-classes'] !== undefined ||
    values['ignore-classes'] !== undefined ||
    values['ignore-authors'] !== undefined ||
    values.settled;
  if (!['json', 'text', 'compact', 'ndjson', 'template'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json, text, compact, ndjson, or template',
      { monitorId, at },
      format,
    );
  if (values['omit-end'] && values.format !== 'ndjson')
    return errorResult(
      'config',
      '--omit-end requires --format ndjson',
      { monitorId, at },
      ['json', 'text', 'compact', 'ndjson'].includes(values.format) ? values.format : 'json',
    );
  if (values.format === 'template' && (values['omit-end'] || argv.includes('--omit-end')))
    return errorResult(
      'config',
      '--omit-end cannot be used with --format template',
      { monitorId, at },
      'json',
    );
  let compiledTemplate = deps.compiledTemplate;
  if (compiledTemplate === undefined) {
    const resolvedTemplate = resolveCompiledTemplate(values, argv, {
      ...configDeps(deps),
      env,
      templateReadFileSync: deps.readFileSync,
      lstatSync: deps.lstatSync,
      realpathSync: deps.realpathSync,
    });
    if (resolvedTemplate.error)
      return errorResult(
        'config',
        resolvedTemplate.error,
        { monitorId, at },
        values.format === 'template' ? 'template' : format,
      );
    compiledTemplate = resolvedTemplate.compiled;
  }
  if (values['outpost-url'] !== undefined) {
    const outpostValidation = validateOutpostUrl(values['outpost-url']);
    if (!outpostValidation.ok)
      return errorResult('config', outpostValidation.error, { monitorId, at }, format);
  }
  if (values['outpost-secret'] !== undefined) {
    const secretName = values['outpost-secret'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName))
      return errorResult(
        'config',
        '--outpost-secret must name an environment variable matching [A-Za-z_][A-Za-z0-9_]*',
        { monitorId, at },
        format,
      );
    if (values['outpost-url'] === undefined)
      return errorResult(
        'config',
        '--outpost-secret requires --outpost-url',
        { monitorId, at },
        format,
      );
    if (typeof env[secretName] !== 'string' || env[secretName].length === 0)
      return errorResult(
        'config',
        `environment variable ${secretName} for --outpost-secret is unset or empty`,
        { monitorId, at },
        format,
      );
  }
  const outpostTimeout = positiveInt('--outpost-timeout-ms', values['outpost-timeout-ms']);
  if (outpostTimeout.error)
    return errorResult('config', outpostTimeout.error, { monitorId, at }, format);
  let outpostMax = { value: Infinity };
  if (values['outpost-max-posts'] !== undefined) {
    outpostMax = positiveInt('--outpost-max-posts', values['outpost-max-posts']);
    if (outpostMax.error) return errorResult('config', outpostMax.error, { monitorId, at }, format);
  }
  const strictWatch = values['watch-strict'] === true;
  if (strictWatch && values['watch-dir'] === undefined)
    return errorResult('config', '--watch-strict requires --watch-dir', { monitorId, at }, format);
  if (strictWatch && !entitySelection.wantsPr)
    return errorResult(
      'config',
      '--watch-strict requires an entity selection including pr',
      { monitorId, at },
      format,
    );
  // Repo resolution/validation happens last: it is the only phase that can
  // touch the network (resolveRepo -> `gh repo view`), so every deterministic,
  // repo-independent config error above must surface first.
  let earlyWatches = null;
  let watchGeneration = null;
  if (values['watch-dir'] !== undefined) {
    try {
      const viewed = loadWatchGeneration(values['watch-dir']);
      earlyWatches = viewed.entries;
      watchGeneration = viewed.generation;
    } catch (err) {
      if (err?.code === 'WATCH_DIR_BUSY')
        return errorResult('busy', String(err.message ?? err), { monitorId, at }, format);
      return errorResult('config', String(err.message ?? err), { monitorId, at }, format);
    }
  }
  if (
    strictWatch &&
    (deps.__multiRepoIndex === undefined || deps.__multiRepoIndex === 0) &&
    earlyWatches.some((entry) => entry.entity === 'issue' && entry.repo === undefined)
  )
    return errorResult(
      'config',
      '--watch-strict cannot include issue watch entries',
      { monitorId, at },
      format,
    );
  let repoInput = values.repo;
  let repoSource = 'flag';
  let derivationWarnings = [];
  const strictEmpty = strictWatch && values['watch-dir'] !== undefined && earlyWatches.length === 0;
  if (!repoInput) {
    const derived = resolveRepo({ ghTimeoutMs: ghTimeoutMs.value, localOnly: strictEmpty });
    if (derived.status === 'declined')
      return errorResult(
        'config',
        strictEmpty
          ? 'missing --repo and could not derive owner/name from local git remotes (origin/upstream)'
          : 'missing --repo and could not derive owner/name from git remotes (origin/upstream) or gh in the current directory',
        { monitorId, at },
        format,
      );
    if (derived.status === 'failed')
      return errorResult(
        'github',
        `could not derive --repo: ${derived.reason}`,
        { monitorId, at },
        format,
      );
    repoInput = derived.repo;
    repoSource = derived.source;
    derivationWarnings = derived.warnings ?? [];
  }
  const repoValidation = validateRepo(repoInput);
  if (!repoValidation.ok)
    return errorResult('config', repoValidation.error, { repo: repoInput, monitorId, at }, format);
  const repo = repoValidation.repo;
  const ids = { repo, monitorId, at };
  let watches = [],
    selectedNumbers = numberSelection.numbers,
    watchFiles = new Map(),
    effectiveWatchDir;
  if (values['watch-dir'] !== undefined) {
    effectiveWatchDir = values['watch-dir'];
    // A scoped watch belongs only to its named repository. Legacy entries are
    // deliberately assigned to the first selected repo so old directories
    // keep their exact one-repo behavior when composition is introduced.
    watches = earlyWatches.filter(
      (entry) =>
        entry.repo === repo ||
        (entry.repo === undefined &&
          (deps.__multiRepoIndex === undefined || deps.__multiRepoIndex === 0)),
    );
    const effectiveTargets = new Set();
    for (const entry of watches) {
      const target = `${repo}:${entry.entity}:${entry.number}`;
      if (effectiveTargets.has(target))
        return errorResult('config', `duplicate effective watch entry ${target}`, ids, format);
      effectiveTargets.add(target);
    }
    selectedNumbers = new Set(watches.map((entry) => `${entry.entity}:${entry.number}`));
    try {
      if (watchGeneration === null) {
        for (const captured of captureWatchFiles(effectiveWatchDir, watches)) {
          watchFiles.set(`${captured.entry.entity}:${captured.entry.number}`, captured);
        }
      } else {
        for (const entry of watches) {
          watchFiles.set(`${entry.entity}:${entry.number}`, {
            entry,
            path: join(effectiveWatchDir, watchFilename(entry)),
          });
        }
      }
    } catch (err) {
      return errorResult('config', String(err.message ?? err), ids, format);
    }
  }
  if (strictWatch && watches.some((entry) => entry.entity === 'issue'))
    return errorResult('config', '--watch-strict cannot include issue watch entries', ids, format);
  const economicalWatch =
    values['watch-dir'] !== undefined &&
    entitySelection.wantsPr &&
    watches.every((entry) => entry.entity === 'pr') &&
    (strictWatch || watches.length <= 10);
  // Wait preflight shares the full validation path without publishing a tick.
  if (deps.__validateOnly) return { code: 0, report: { ...ids }, format };
  const usedDefaultDir = !values['state-file'] && !values['state-dir'];
  let stateFile = values['state-file'];
  if (stateFile && economicalWatch) {
    stateFile = economicalSnapshotPath(repo, monitorId, entitySelection.key, null, { stateFile });
  } else if (!stateFile) {
    let baseDir = values['state-dir'];
    if (!baseDir) {
      baseDir = defaultStateDir();
      try {
        // Per-user isolation on shared /tmp. mkdirSync({recursive:true})
        // succeeds silently on a pre-existing dir, so refuse a default dir
        // the current user does not own (no-op on Windows).
        mkdirSync(baseDir, { recursive: true, mode: 0o700 });
        if (typeof process.getuid === 'function') {
          const owner = statSync(baseDir).uid;
          if (owner !== process.getuid()) {
            return errorResult(
              'io',
              `default state dir ${baseDir} is owned by uid ${owner}, not the current user; pass --state-dir explicitly`,
              ids,
              format,
            );
          }
        }
      } catch (err) {
        return errorResult('io', String(err?.message ?? err), ids, format);
      }
    }
    stateFile = economicalWatch
      ? economicalSnapshotPath(repo, monitorId, entitySelection.key, baseDir)
      : snapshotPath(repo, monitorId, entitySelection.key, baseDir);
  }
  const logFile = values.log
    ? resolve(
        deltaLogPath({
          ...(values['state-file'] || economicalWatch ? { stateFile } : {}),
          stateDir: values['state-file'] || economicalWatch ? undefined : dirname(stateFile),
          repo,
          monitorId,
          entities: entitySelection.key,
        }),
      )
    : undefined;
  const registryEnabled = !values['no-registry'] && !envDisablesRegistry(env.GH_DELTA_NO_REGISTRY);
  const usesGeneratedMonitorId = !values['monitor-id'] && !env.GH_DELTA_MONITOR_ID;
  const monitorIdentityWarnings = () => {
    if (!usesGeneratedMonitorId || format !== 'text') return [];
    try {
      const registryDir = defaultRegistryDir({ env });
      const collision = readRegistry(registryDir).entries.some(
        (entry) =>
          entry.repo === repo && entry.machineId === machineId && entry.monitorId !== monitorId,
      );
      return collision
        ? [
            {
              label: 'monitor-id',
              reason: 'multiple local monitor identities exist; pass --monitor-id explicitly',
            },
          ]
        : [];
    } catch {
      // Diagnostic registry reads are best-effort and intentionally silent.
      return [];
    }
  };
  const registerAttempt = (status, error) => {
    if (!registryEnabled) return;
    try {
      registerMonitor({
        repo,
        monitorId,
        entities: economicalWatch ? ['pr'] : entitySelection.selected,
        stateFile,
        ...(economicalWatch ? { scope: 'watch-pr' } : {}),
        ...(effectiveWatchDir ? { watchDir: effectiveWatchDir } : {}),
        machineId,
        at,
        lastRun: at,
        status,
        ...(error ? { error } : {}),
        env,
      });
    } catch {
      // The registry is diagnostics only; it cannot alter detector semantics.
    }
  };
  const omitEnd = values['omit-end'] === true && format === 'ndjson';
  const failedAttempt = (kind, error, extra = {}) => {
    registerAttempt('failure', { kind, message: String(error?.message ?? error) });
    return {
      ...errorResult(
        kind,
        String(error?.message ?? error),
        { ...ids, repoSource, stateFile, entities: entitySelection.selected, ...extra },
        format,
      ),
      warnings: [...derivationWarnings, ...monitorIdentityWarnings()],
      ...(omitEnd ? { omitEnd: true } : {}),
      ...(compiledTemplate ? { template: compiledTemplate } : {}),
    };
  };

  // Acquire the state-file lock BEFORE reading the snapshot, and BEFORE any
  // GitHub call -- a busy acquisition must never be mistaken for a failed
  // fetch. acquireLock itself ensures the state file's parent directory
  // exists (recursive mkdir, through the same injectable `fs` as the rest of
  // the lock): the directory used to be created lazily by
  // writeSnapshotAtomic at write time, but the lock now runs before the
  // snapshot read/write, so an explicit --state-dir or --state-file whose
  // directory doesn't exist yet would otherwise fail acquireLock's
  // exclusive-create with ENOENT on a first run (the default temp dir above
  // is already created with its own 0700/ownership handling, which stays
  // scoped to that case only -- acquireLock's mkdir is a harmless no-op on
  // an already-existing directory). The initial lease is short (one
  // --gh-timeout-ms + slack, enough for a single `gh` call);
  // fetchPRs/fetchIssues extend it per completed pagination page via
  // onLockProgress below (see docs/contract.md "Lock Semantics").
  const lockDeps = { fs: lockFs, now: lockNow };
  let lockToken;
  let lockWarning;
  try {
    const acquired = acquireLock(stateFile, {
      ghTimeoutMs: ghTimeoutMs.value,
      staleMs: lockStaleMs.ms,
      ...lockDeps,
    });
    if (!acquired.ok) {
      return failedAttempt('busy', `state file locked (${acquired.reason}): ${stateFile}`);
    }
    lockToken = acquired.token;
    if (acquired.warning) lockWarning = { label: 'lock', reason: acquired.warning };
  } catch (err) {
    return failedAttempt('io', err);
  }
  // Invoked by fetchPRs/fetchIssues after each successfully completed
  // pagination page -- ordinary synchronous control flow between two
  // execFileSync calls, not a timer, so it reliably runs. Silently does
  // nothing if ownership was already lost; the pre-write fence is what
  // surfaces that as `busy`.
  const onLockProgress = () => {
    extendLockDeadline(stateFile, lockToken, { ghTimeoutMs: ghTimeoutMs.value, ...lockDeps });
  };

  try {
    let old;
    try {
      old = readSnapshot(stateFile);
      if (economicalWatch && old) {
        // Membership is a projection, not a missing event: a removed watch
        // exits this independent universe before the normal diff lifecycle.
        const watchedNumbers = new Set(watches.map((entry) => String(entry.number)));
        old = {
          ...old,
          pr: Object.fromEntries(
            Object.entries(old.pr).filter(([number]) => watchedNumbers.has(number)),
          ),
          issue: {},
        };
      }
    } catch (err) {
      return failedAttempt('snapshot', err);
    }
    let cutoff;
    try {
      cutoff = horizonCutoff(old);
    } catch (err) {
      return failedAttempt('snapshot', err);
    }
    let current;
    // Accumulated GraphQL quota spend for this tick, summed across every
    // observation family fetched below and every enrichment call further
    // down. Surfaced as `results[].rateLimit` in the report envelope (see
    // buildDetectorReport below).
    let tickRateLimit = null;
    try {
      const strictBatches = economicalWatch
        ? prBatches(watches.map((entry) => entry.number))
        : null;
      if (rateLimitFloor !== null && !(strictWatch && strictBatches?.length === 0)) {
        const limit = fetchRateLimit({ timeoutMs: ghTimeoutMs.value, onProgress: onLockProgress });
        if (strictWatch) {
          if (
            !admitBatch({
              remaining: limit.remaining,
              floor: rateLimitFloor.value,
              batchesStillNeeded: strictBatches.length,
            })
          )
            return failedAttempt(
              'rate-limit',
              `GitHub GraphQL rate limit remaining ${limit.remaining} is below the strict admission line for floor ${rateLimitFloor.value} and ${strictBatches.length} batch(es)`,
              // The pre-fetch REST check has no per-query cost; carry `cost: null`
              // so this shares the same {cost, remaining, resetAt} shape as the
              // post-fetch GraphQL rateLimit accumulated below.
              { resetAt: limit.resetAt, remaining: limit.remaining, cost: null },
            );
        } else if (limit.remaining < rateLimitFloor.value)
          return failedAttempt(
            'rate-limit',
            `GitHub GraphQL rate limit remaining ${limit.remaining} is below configured floor ${rateLimitFloor.value}`,
            { resetAt: limit.resetAt, remaining: limit.remaining, cost: null },
          );
      }
      // A PR-only local watch list is an independent universe. Strict mode
      // fetches it in sorted batches of ten; a short non-strict list is one
      // batch. It never asks GitHub for issues; null aliases flow into normal
      // missing detection because the selected PR numbers remain absent from `pr`.
      if (economicalWatch) {
        const rows = [];
        let latest = null;
        for (let index = 0; index < strictBatches.length; index++) {
          if (strictWatch && rateLimitFloor !== null && index > 0) {
            const batchesStillNeeded = strictBatches.length - index;
            if (
              !admitBatch({
                remaining: latest.remaining,
                floor: rateLimitFloor.value,
                batchesStillNeeded,
              })
            )
              return failedAttempt(
                'rate-limit',
                `GitHub GraphQL rate limit remaining ${latest.remaining} is below the strict admission line for floor ${rateLimitFloor.value} and ${batchesStillNeeded} batch(es)`,
                {
                  resetAt: latest.resetAt,
                  remaining: latest.remaining,
                  cost: tickRateLimit?.cost ?? null,
                },
              );
          }
          const prFetch = fetchPRsByNumber(repo, strictBatches[index], {
            timeoutMs: ghTimeoutMs.value,
            onProgress: onLockProgress,
          });
          rows.push(...prFetch.rows);
          latest = prFetch.rateLimit;
          tickRateLimit = accumulateTickRateLimit(tickRateLimit, prFetch.rateLimit);
        }
        current = { pr: rows, issue: [] };
      } else {
        const prFetch = entitySelection.wantsPr
          ? fetchPRs(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined;
        const issueFetch = entitySelection.wantsIssue
          ? fetchIssues(repo, {
              timeoutMs: ghTimeoutMs.value,
              horizonCutoff: cutoff,
              onProgress: onLockProgress,
            })
          : undefined;
        current = { pr: prFetch?.rows, issue: issueFetch?.rows };
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, prFetch?.rateLimit);
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, issueFetch?.rateLimit);
      }
    } catch (err) {
      return failedAttempt('github', err);
    }
    let baseline, deltas, snapshot, rawDeltas;
    const watchTerminalIgnoresToRecord = [];
    let filteredDeltas = 0;
    const ignoreAuthorsWarnings = [];
    try {
      ({ baseline, deltas, snapshot } = detectDeltas(old, current, {
        emitBaselineState: values['baseline-emit-state'],
        at,
        staleAfterMs: staleAfter?.ms,
      }));
      // Attach the content-addressed id (and repo) here: detect.mjs is
      // repo-agnostic, but both are scoped by repo. Rebuild each delta with
      // `id` first so the dedupe key leads the serialized object; `repo` is
      // always present on a delta now, single-repo included.
      deltas = deltas.map((d) => ({ id: deltaId(deltaIdentity(repo, d)), repo, ...d }));
      // Apply --number scope before any enrichment (including the
      // --ignore-authors thread-reply fetch below): a delta outside the
      // requested selection should never spend fetch quota or produce a
      // warning naming it, since it will be dropped from the final report
      // regardless.
      if (selectedNumbers)
        deltas = deltas.filter((delta) =>
          selectedNumbers.has(
            typeof [...selectedNumbers][0] === 'string'
              ? `${delta.entity}:${delta.number}`
              : delta.number,
          ),
        );
      if (attentionFiltering) {
        // summary/changed are always-on now; enrich before the settled
        // predicate so `filtered.summary` is available for it, then render
        // only the surviving deltas so display fields match filtered classes.
        for (const d of deltas) enrichDelta(d, {});
        const preAttentionDeltas = deltas;
        const attention = applyAttentionFilters(deltas, {
          onlyClasses: onlyClasses.classes,
          ignoreClasses: ignoreClasses.classes,
          settled: false,
        });
        deltas = attention.deltas;
        filteredDeltas = attention.filteredDeltas;
        // Detect any watched item whose terminal transition THIS applyAttentionFilters
        // call actually suppressed -- using its real survivors, not a
        // re-derivation from the flag values (see
        // watchedTerminalTransitionSuppressed's doc comment for why that
        // distinction matters). Must run here, immediately after filtering,
        // rather than in the cleanup loop below: a delta whose terminal
        // class did not survive at all is absent from `deltas` entirely, so
        // that loop -- which only ever sees post-filter survivors -- could
        // never observe that a transition happened here in the first place.
        // Attention filtering runs before both the report and the durable
        // log, so this is the only point where that fact is still visible.
        const survivedByKey = new Map(deltas.map((d) => [`${d.entity}:${d.number}`, d]));
        for (const delta of preAttentionDeltas) {
          const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
          const survivor = survivedByKey.get(`${delta.entity}:${delta.number}`);
          if (watchedTerminalTransitionSuppressed(delta, watched, survivor))
            watchTerminalIgnoresToRecord.push(watched);
        }
        if (ignoreAuthors.authors.length) {
          const doubleOptIn = enrichmentSelection.kinds.includes('thread-replies');
          const threadReplyRows = new Map();
          for (const delta of deltas) {
            if (!delta.classes.includes('review-comments-added')) continue;
            if (!doubleOptIn) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}) carries review-comments-added but --enrich thread-replies is not set; cannot verify reply authors, failing open`,
              });
              continue;
            }
            const increments = threadReplyIncrements(
              fpOf(delta.from)?.threads,
              fpOf(delta.to)?.threads,
            );
            // threadReplyIncrements only names threads present on both sides of
            // the tick (see its doc comment in lib/detect.mjs); a thread opened
            // this same tick has no `from` baseline and is silently excluded.
            // When one or more such brand-new threads make up part (or all) of
            // the observed reviewComments rise, the increments we DID find can
            // never cover the whole rise -- verifying only the covered slice and
            // suppressing on it would silently drop a delta that may be hiding
            // an unaccounted, possibly human, reply in the uncovered remainder.
            // Require full coverage before trusting the fetched rows at all;
            // anything less is exactly as unverifiable as the !doubleOptIn case
            // above and warns the same way.
            const observedRise =
              (fpOf(delta.to)?.reviewComments ?? NaN) - (fpOf(delta.from)?.reviewComments ?? NaN);
            const covered = increments.reduce((sum, entry) => sum + entry.increment, 0);
            if (!(covered >= observedRise)) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}) carries review-comments-added but only ${covered} of ${observedRise} new review comment(s) are attributable to a thread with a prior baseline; cannot verify reply authors, failing open`,
              });
              continue;
            }
            try {
              // The one documented exception to "opt-in enrichment quota is spent
              // only after publication": this call is scoped to the filter decision
              // only (its rows feed authorsIgnored above, never delta.enrichment)
              // and its own quota is accounted in tickRateLimit like any other
              // fetch. A delta that survives filtering is still eligible for the
              // normal post-publish --enrich thread-replies pass below, which
              // re-fetches independently -- this pass never populates
              // delta.enrichment itself.
              const { rows, rateLimit: callRateLimit } = fetchThreadRepliesGh(increments, {
                timeoutMs: ghTimeoutMs.value,
                onProgress: onLockProgress,
              });
              tickRateLimit = accumulateTickRateLimit(tickRateLimit, callRateLimit);
              threadReplyRows.set(delta.id, rows);
            } catch (err) {
              ignoreAuthorsWarnings.push({
                label: 'ignore-authors thread-replies',
                reason: `delta ${delta.id} (${delta.entity} #${delta.number}): ${String(err?.message ?? err)}; failing open`,
              });
            }
          }
          const authorFiltered = deltas.map((delta) =>
            authorsIgnored(delta, ignoreAuthors.authors, { threadReplyRows }),
          );
          deltas = authorFiltered.map(({ delta }) => delta).filter(Boolean);
          // A class removal on a surviving delta is not a filtered delta.
          filteredDeltas += authorFiltered.filter(({ delta }) => delta == null).length;
        }
        if (values.settled) {
          const settled = applyAttentionFilters(deltas, {
            onlyClasses: [],
            ignoreClasses: [],
            settled: true,
          });
          deltas = settled.deltas;
          filteredDeltas += settled.filteredDeltas;
        }
        for (const d of deltas) {
          enrichDelta(d, {
            summaryLine: values['summary-line'] || values.detail,
            details: values.detail,
          });
        }
      } else {
        for (const d of deltas) {
          enrichDelta(d, {
            summaryLine: values['summary-line'] || values.detail,
            details: values.detail,
          });
        }
      }
      // Public contract: delta.from/delta.to are the bare compared fingerprint,
      // not the full {fingerprint, context, meta} snapshot item -- context is
      // already its own top-level delta field (never duplicated under to/from),
      // and delta.id already hashes exactly to.fingerprint (see deltaIdentity),
      // so this makes `to` what the id actually hashes. Every internal
      // consumer that needed the full item (detail builders, diffFingerprint,
      // deltaSummary via enrichDelta, above) has already run; strip here,
      // once, before this shape reaches the durable log, enrichment, outpost,
      // and the report. deltaSummary() itself still takes a full-item `to`
      // (see lib/summary.mjs) -- its other caller, snapshotSummaryMatches()
      // below, synthesizes one from a fresh snapshot read. Any code reading a
      // delta AFTER this strip (report.deltas, the durable log, --from-log)
      // must use the already-computed `delta.summary`, never call
      // deltaSummary(delta) again -- see waitSummaryMatches().
      for (const delta of deltas) {
        delta.from = delta.from?.fingerprint ?? null;
        delta.to = delta.to?.fingerprint ?? null;
      }
      for (const delta of deltas) {
        const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
        const labels = watched?.entry?.labels;
        if (labels && Object.keys(labels).length > 0) delta.watch = { labels };
      }
      // Kept as a separate reference (not stripped) so enrichment below, which
      // runs after snapshot publication, can still find the persisted
      // identities (reviews/recentComments/...) it needs to fetch bodies.
      rawDeltas = deltas;
    } catch (err) {
      return failedAttempt('github', err);
    }

    // The fence: immediately before writing, re-verify the lock still names
    // our token. If ownership was lost during the fetch (the lock expired
    // and was stolen), fail with `busy` and write nothing -- see lib/lock.mjs
    // and docs/contract.md for the residual race this narrows but does not close.
    if (!assertLockOwned(stateFile, lockToken, lockDeps)) {
      return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
    }

    try {
      assertTemplateDeltas(compiledTemplate, deltas);
    } catch (err) {
      return failedAttempt('config', err);
    }

    const publishSnapshot = () =>
      writeSnapshotAtomic(
        stateFile,
        {
          ...snapshot,
          meta: {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            ghDeltaVersion: getPackageMetadata().version,
            repo,
            monitorId,
            entities: economicalWatch ? ['pr'] : entitySelection.selected,
            scope: economicalWatch ? 'watch-pr' : 'poll',
            horizon: at,
            createdAt: old?.meta?.createdAt ?? at,
            updatedAt: at,
          },
        },
        {
          ...(usedDefaultDir ? { dirMode: 0o700 } : {}),
          verifyBeforeCommit: () => assertLockOwned(stateFile, lockToken, lockDeps),
        },
      );

    const loadWatchAtPublish =
      deps.readWatchGeneration == null || deps.readWatchGeneration === readWatchGeneration
        ? readWatchGenerationUnlocked
        : deps.readWatchGeneration;
    let cleanupGeneration = watchGeneration;
    // Log first, then mark and publish: a durable record must precede the
    // snapshot that makes its delta unrepeatable. Manifest marks stay unlocked
    // here because withWatchDirLock below already holds the watch-dir lock.
    const publishAndLog = () => {
      if (values.log && deltas.length > 0) {
        try {
          const { fromSeq } = appendDeltaLog(
            logFile,
            { detectedAt: at, deltas: deltas.map((delta) => ({ ...delta })), repo, monitorId },
            {
              onProgress: () =>
                extendLockDeadline(stateFile, lockToken, {
                  ghTimeoutMs: ghTimeoutMs.value,
                  ...lockDeps,
                }),
              verifyBeforeMutation: () => assertLockOwned(stateFile, lockToken, lockDeps),
            },
          );
          deltas.forEach((delta, index) => {
            delta.seq = fromSeq + index;
          });
        } catch (err) {
          if (err?.code === 'LOCK_LOST') {
            return failedAttempt('busy', `lock lost before delta log write: ${stateFile}`);
          }
          return failedAttempt(err?.kind === 'log' ? 'log' : 'io', err);
        }
        if (!assertLockOwned(stateFile, lockToken, lockDeps)) {
          return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
        }
      }
      try {
        if (watchTerminalIgnoresToRecord.length) {
          if (watchGeneration !== null) {
            cleanupGeneration = markManifestTerminalIgnoredUnlocked(
              effectiveWatchDir,
              watchTerminalIgnoresToRecord.map((watched) => watched.entry),
              at,
              watchGeneration,
            );
            publishSnapshot();
          } else {
            withWatchTerminalMarkLocks(
              watchTerminalIgnoresToRecord.map((watched) => watched.path),
              () => {
                for (const watched of watchTerminalIgnoresToRecord) {
                  if (!writeWatchTerminalIgnoredLocked(watched.path, watched.bytes, at)) {
                    const err = new Error(
                      `watch entry changed concurrently before it could be marked: ${watched.path}`,
                    );
                    err.kind = 'watch-entry-busy';
                    throw err;
                  }
                }
                publishSnapshot();
              },
            );
          }
        } else {
          publishSnapshot();
        }
      } catch (err) {
        if (err?.kind === 'watch-entry-busy' || err?.code === 'WATCH_DIR_BUSY') {
          return failedAttempt('busy', err.message);
        }
        if (err?.code === 'LOCK_LOST') {
          return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
        }
        return failedAttempt('io', err);
      }
      return null;
    };

    if (effectiveWatchDir) {
      try {
        const failed = withWatchDirLock(effectiveWatchDir, () => {
          const latest = loadWatchAtPublish(effectiveWatchDir);
          if (latest.generation !== watchGeneration) {
            const err = new Error('watch membership changed before publication');
            err.code = 'WATCH_DIR_BUSY';
            throw err;
          }
          // Legacy directories have no generation; strict mode also compares membership.
          if (strictWatch) {
            const membershipToken = (entries) =>
              JSON.stringify(
                entries
                  .filter(
                    (entry) =>
                      entry.repo === repo ||
                      (entry.repo === undefined &&
                        (deps.__multiRepoIndex === undefined || deps.__multiRepoIndex === 0)),
                  )
                  .map((entry) => ({
                    entity: entry.entity,
                    number: entry.number,
                    until: entry.until,
                    repo: entry.repo ?? null,
                  }))
                  .sort((a, b) => a.entity.localeCompare(b.entity) || a.number - b.number),
              );
            if (membershipToken(latest.entries) !== membershipToken(watches)) {
              const err = new Error('watch membership changed before publication');
              err.code = 'WATCH_DIR_BUSY';
              throw err;
            }
          }
          return publishAndLog();
        });
        if (failed) return failed;
      } catch (err) {
        if (err?.code === 'WATCH_DIR_BUSY')
          return failedAttempt('busy', 'watch membership changed before publication');
        return failedAttempt('io', err);
      }
    } else {
      const failed = publishAndLog();
      if (failed) return failed;
    }
    registerAttempt('ok');
    const cleanupWarnings = [];
    const manifestRemovals = [];
    for (const delta of deltas) {
      const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
      // Schema v2 lowercases every enum at fetch time (lib/gh.mjs), so the
      // terminal test reads `open`/`merged`, not v1's `OPEN`/`MERGED`.
      const state = delta.to?.state;
      const cleanupEligible =
        watched &&
        isTerminalCleanupEligible(delta, watched.entry, {
          onlyClasses: onlyClasses.classes,
          ignoreClasses: ignoreClasses.classes,
        });
      if (
        watched &&
        cleanupEligible &&
        ((watched.entry.until === 'merged' && state === 'merged') ||
          (watched.entry.until === 'closed' && state !== 'open'))
      ) {
        if (watchGeneration !== null) {
          manifestRemovals.push({
            entity: watched.entry.entity,
            number: watched.entry.number,
            ...(watched.entry.repo !== undefined ? { repo: watched.entry.repo } : {}),
          });
        } else {
          try {
            removeWatchedFile(watched.path, watched.bytes);
          } catch (err) {
            cleanupWarnings.push({ label: 'watch cleanup', reason: String(err.message ?? err) });
          }
        }
      }
    }
    if (watchGeneration !== null && manifestRemovals.length) {
      try {
        removeManifestEntries(effectiveWatchDir, manifestRemovals, cleanupGeneration);
      } catch (err) {
        cleanupWarnings.push({ label: 'watch cleanup', reason: String(err.message ?? err) });
      }
    }
    // This is intentionally after the atomic snapshot publish.  A failed
    // publication therefore cannot spend opt-in quota, and the durable log
    // above remains a replayable pre-enrichment record.
    const enrichmentResult = enrichmentSelection.kinds.length
      ? enrichEmittedDeltas(rawDeltas, enrichmentSelection.kinds, {
          fetch: (kind, ids) =>
            kind === 'thread-replies'
              ? fetchThreadRepliesGh(ids, {
                  timeoutMs: ghTimeoutMs.value,
                  onProgress: onLockProgress,
                })
              : fetchEnrichment(kind, ids, {
                  timeoutMs: ghTimeoutMs.value,
                  onProgress: onLockProgress,
                }),
        })
      : { warnings: [], rateLimit: null };
    const enrichmentWarnings = enrichmentResult.warnings;
    tickRateLimit = accumulateTickRateLimit(tickRateLimit, enrichmentResult.rateLimit);
    const summary = baseline
      ? `baseline established: ${Object.keys(snapshot.pr).length} PRs, ${Object.keys(snapshot.issue).length} issues${
          deltas.length ? `; ${deltas.length} baseline-state delta(s)` : ''
        }`
      : `${deltas.length} delta(s)`;
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      baseline,
      repo,
      repoSource,
      monitorId,
      entities: entitySelection.selected,
      stateFile,
      ...(values.log ? { logFile } : {}),
      at,
      deltas,
      filteredDeltas,
      summary,
    };
    const warnings = [
      ...derivationWarnings,
      ...(lockWarning ? [lockWarning] : []),
      ...monitorIdentityWarnings(),
      ...cleanupWarnings,
      ...enrichmentWarnings,
      ...ignoreAuthorsWarnings,
    ];
    try {
      assertTemplateDeltas(compiledTemplate, deltas);
    } catch (err) {
      return { ...failedAttempt('config', err), warnings };
    }
    return {
      // A baseline normally exits 0 with empty deltas; --baseline-emit-state makes
      // it emit baseline-state deltas, and any run with deltas exits 10. Since only
      // that flag can pair baseline === true with a non-empty deltas array, this
      // stays byte-identical to `baseline || deltas.length === 0 ? 0 : 10` on every
      // pre-existing path.
      code: deltas.length === 0 ? 0 : 10,
      report,
      format,
      warnings,
      ...(compiledTemplate ? { template: compiledTemplate } : {}),
      // Internal-only, not part of `report`: the tick's accumulated GraphQL
      // quota spend (observation fetches above + enrichment above). Sibling
      // to `report` deliberately -- buildDetectorReport (below) is what
      // surfaces it as `results[].rateLimit` in the public report envelope.
      rateLimit: tickRateLimit,
      ...(omitEnd ? { omitEnd: true } : {}),
    };
  } finally {
    // Every exit path from the try block above -- success or any thrown/
    // returned error -- releases the lock. releaseLock is a no-op if our
    // token no longer matches (ownership already lost; see the fence above).
    releaseLock(stateFile, lockToken, lockDeps);
  }
}

export { runDetector };
