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
import { removeWatchUnchanged, readWatch, watchFilename } from '../watch.mjs';
import { withTerminalMarkLocks, writeTerminalIgnoredLocked } from '../watch-lock.mjs';
import {
  parseCli,
  positiveInt,
  nonNegativeSafeInt,
  watchNumbers,
  parseDeltaClassSelection,
} from './parse.mjs';
import { errorResult } from './errors.mjs';
import { parseDuration } from '../duration.mjs';
import { selectedMonitorId, envDisablesRegistry } from './config.mjs';
import { validateOutpostUrl } from '../outpost.mjs';
import { join, resolve, dirname } from 'node:path';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
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
  if (!['json', 'text', 'compact', 'ndjson'].includes(values.format))
    return errorResult(
      'config',
      '--format must be json, text, compact, or ndjson',
      { monitorId, at },
      format,
    );
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
  // Repo resolution/validation happens last: it is the only phase that can
  // touch the network (resolveRepo -> `gh repo view`), so every deterministic,
  // repo-independent config error above must surface first.
  let earlyWatches = null;
  if (values['watch-dir'] !== undefined) {
    try {
      earlyWatches = readWatch(values['watch-dir']);
    } catch (err) {
      return errorResult('config', String(err.message ?? err), { monitorId, at }, format);
    }
  }
  let repoInput = values.repo;
  let repoSource = 'flag';
  let derivationWarnings = [];
  if (!repoInput) {
    const derived = resolveRepo({ ghTimeoutMs: ghTimeoutMs.value });
    if (derived.status === 'declined')
      return errorResult(
        'config',
        'missing --repo and could not derive owner/name from git remotes (origin/upstream) or gh in the current directory',
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
    for (const entry of watches) {
      const path = join(effectiveWatchDir, watchFilename(entry));
      try {
        watchFiles.set(`${entry.entity}:${entry.number}`, {
          entry,
          path,
          bytes: readFileSync(path, 'utf8'),
        });
      } catch {
        return errorResult('config', `invalid watch entry ${path}`, ids, format);
      }
    }
  }
  const economicalWatch =
    values['watch-dir'] !== undefined &&
    entitySelection.wantsPr &&
    watches.length <= 10 &&
    watches.every((entry) => entry.entity === 'pr');
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
      if (rateLimitFloor !== null) {
        const limit = fetchRateLimit({ timeoutMs: ghTimeoutMs.value, onProgress: onLockProgress });
        if (limit.remaining < rateLimitFloor.value)
          return failedAttempt(
            'rate-limit',
            `GitHub GraphQL rate limit remaining ${limit.remaining} is below configured floor ${rateLimitFloor.value}`,
            // The pre-fetch REST check has no per-query cost; carry `cost: null`
            // so this shares the same {cost, remaining, resetAt} shape as the
            // post-fetch GraphQL rateLimit accumulated below.
            { resetAt: limit.resetAt, remaining: limit.remaining, cost: null },
          );
      }
      // A small all-PR local watch list is an independent, bounded universe.
      // It never asks GitHub for issues; null aliases flow into normal missing
      // detection because the selected PR numbers remain absent from `pr`.
      if (economicalWatch) {
        const prFetch = watches.length
          ? fetchPRsByNumber(
              repo,
              watches.map((entry) => entry.number),
              {
                timeoutMs: ghTimeoutMs.value,
                onProgress: onLockProgress,
              },
            )
          : { rows: [], rateLimit: null };
        current = { pr: prFetch.rows, issue: [] };
        tickRateLimit = accumulateTickRateLimit(tickRateLimit, prFetch.rateLimit);
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

    if (values.log && deltas.length > 0) {
      try {
        // The same snapshot lock serializes producers. Do not move this after
        // snapshot publication: a durable log record must precede the state
        // that makes its delta unrepeatable.
        const { fromSeq } = appendDeltaLog(
          logFile,
          // Shallow-copy each delta: enrichment (below) mutates `delta.enrichment`
          // on these same objects in place once opted in, and the durable log
          // must stay the pre-enrichment public stream regardless of object
          // identity, not only regardless of the bytes already on disk.
          { detectedAt: at, deltas: deltas.map((delta) => ({ ...delta })), repo, monitorId },
          {
            // Renew at the log-mutation boundary, then let deltalog fence each
            // destructive write after its own scan/serialization work. This is
            // the log equivalent of snapshot.mjs's verifyBeforeCommit fence.
            onProgress: () =>
              extendLockDeadline(stateFile, lockToken, {
                ghTimeoutMs: ghTimeoutMs.value,
                ...lockDeps,
              }),
            verifyBeforeMutation: () => assertLockOwned(stateFile, lockToken, lockDeps),
          },
        );
        // Stamp the journal record number onto each delta object BEFORE
        // enrichment runs (below) and before report assembly reads `deltas`.
        // `deltas` and `rawDeltas` are the same array reference in the same
        // order appendDeltaLog just wrote, so record i's seq is fromSeq + i --
        // this must stay index-aligned with the exact array appendDeltaLog
        // consumed, not a copy or a re-sorted view of it.
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

    // Self-describing snapshot: identity travels in the data, not only in the
    // derived filename, so `list` can recognize --state-file snapshots too.
    // verifyBeforeCommit re-runs the same ownership check immediately before
    // writeSnapshotAtomic's final renameSync -- the earlier assertLockOwned
    // check above is cheaper (fails before the JSON serialize/temp-write
    // work), but this is the one that actually shrinks the residual race to
    // a single syscall gap. See lib/lock.mjs and docs/contract.md.
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
    try {
      if (watchTerminalIgnoresToRecord.length) {
        // Round 9 of the same finding: every prior round moved a CHECK
        // (verify the mark survived; re-verify immediately before publish)
        // and each move only shrank a time-of-check-to-time-of-use window,
        // never closed it, because the check and the snapshot write stayed
        // two separate operations with nothing held across both. The fix is
        // a lock SCOPE change, not another check: hold every affected watch
        // entry's own lock for the mark write AND the snapshot publish
        // together, so a concurrent `watch add`/`rm` on the SAME entry (a
        // genuinely separate resource from the state-file lock this tick
        // already holds -- see withTerminalMarkLocks's doc comment for why
        // that is verified, not assumed, and why nesting these two locks in
        // this order cannot deadlock) can only land strictly before this
        // block starts or strictly after it returns, never during. See
        // lib/watch.mjs's withTerminalMarkLocks for the full reasoning:
        // deadlock safety, critical-section sizing, and what happens if the
        // process dies inside it.
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
          // No leaseMs override here, deliberately: this critical section is
          // a disk write (the mark, then the snapshot publish), not a GitHub
          // call and not the corrupt-lock ceiling --lock-stale-ms documents,
          // so it uses withTerminalMarkLocks' own fixed internal default
          // (ENTRY_LOCK_LEASE_MS) rather than any user-facing flag. Passing
          // --gh-timeout-ms (round 10) or --lock-stale-ms (round 11) here was
          // tried and reverted both times -- see withTerminalMarkLocks' doc
          // comment (round 12 of this finding) for why neither flag's
          // documented meaning has anything to do with this lease.
        );
      } else {
        publishSnapshot();
      }
    } catch (err) {
      if (err?.kind === 'watch-entry-busy') return failedAttempt('busy', err.message);
      if (err?.code === 'LOCK_LOST') {
        return failedAttempt('busy', `lock lost before snapshot write: ${stateFile}`);
      }
      return failedAttempt('io', err);
    }
    registerAttempt('ok');
    const cleanupWarnings = [];
    for (const delta of deltas) {
      const watched = watchFiles.get(`${delta.entity}:${delta.number}`);
      // Schema v2 lowercases every enum at fetch time (lib/gh.mjs), so the
      // terminal test reads `open`/`merged`, not v1's `OPEN`/`MERGED`.
      const state = delta.to?.state;
      // `state` decides what "terminal" MEANS (a merged PR never reaches
      // `closed` -- see lib/detect.mjs's classifyPr -- so `--until closed`
      // must still recognize `merged` as terminal, per #57).
      // `isTerminalCleanupEligible` decides whether THIS delta may act on
      // that -- see its doc comment for the four-case distinction. Marking
      // a watch entry as having had a transition ignored is handled
      // entirely by the PRE-publish watchTerminalIgnoresToRecord write
      // above: it already covers this delta whether its terminal class was
      // fully dropped or survived alongside another class (e.g. a same-tick
      // merge+relabel), so there is nothing left to mark here -- only
      // removal (best-effort, unlike that marker) is left to this loop.
      //
      // Byte-comparison safety: `watched.bytes` was captured once, at tick
      // start, before either write below can run. removeWatchedFile's
      // compare-then-delete below and the marker write above can never
      // BOTH target the same watch entry in the same tick, so the marker
      // write can never make `watched.bytes` stale for a
      // removeWatchedFile call this same tick would otherwise make --
      // watchedTerminalTransitionSuppressed only marks when `survivor`
      // lacks the terminal class (or is absent entirely), and
      // `cleanupEligible` below can only be true when `delta.classes`
      // (this loop's `delta` IS that same survivor) DOES include it: the
      // two conditions are the direct negation of each other for a given
      // delta. This was not always true -- the granularity bug fixed
      // alongside this comment could make BOTH true for the same delta
      // (a --only-classes match that genuinely kept the terminal class was
      // still flagged as suppressed), which is exactly how a spurious
      // marker wrote pre-marker bytes stale out from under a legitimately
      // eligible cleanup, permanently stranding the entry.
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
        try {
          removeWatchedFile(watched.path, watched.bytes);
        } catch (err) {
          cleanupWarnings.push({ label: 'watch cleanup', reason: String(err.message ?? err) });
        }
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
      // Internal-only, not part of `report`: the tick's accumulated GraphQL
      // quota spend (observation fetches above + enrichment above). Sibling
      // to `report` deliberately -- buildDetectorReport (below) is what
      // surfaces it as `results[].rateLimit` in the public report envelope.
      rateLimit: tickRateLimit,
    };
  } finally {
    // Every exit path from the try block above -- success or any thrown/
    // returned error -- releases the lock. releaseLock is a no-op if our
    // token no longer matches (ownership already lost; see the fence above).
    releaseLock(stateFile, lockToken, lockDeps);
  }
}

export { runDetector };
