// Stable object fingerprints for change detection. These intentionally avoid
// storing large GitHub payloads such as full comment bodies. Comment totals come
// from GraphQL `totalCommentsCount` (PRs) or `comments` scalar (issues), so no
// saturation flag is needed.
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function sortRows(rows, tuple) {
  return [...(rows ?? [])]
    .map((row) => ({ ...row }))
    .sort((a, b) => {
      const ta = tuple(a);
      const tb = tuple(b);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
}

// Matches an Actions run/job path: /<owner>/<repo>/actions/runs/<runId>/job/<jobId>.
const ACTIONS_RUN_JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/;

/**
 * Parse `runId`/`jobId` out of a check row's `detailsUrl`, when it is a
 * recognizable GitHub Actions run/job URL.
 *
 * Anchored to `github.com` only. gh-delta's repo identity is `owner/name`
 * (see lib/repo-source.mjs `parseRemoteUrl`/`resolveRepoFromGit` and
 * lib/gh.mjs `repoParts`) -- no host is ever threaded through fetch or
 * fingerprint routing; `gh` itself resolves the real API host (including a
 * GitHub Enterprise host) from its own auth config, invisible to this code.
 * Widening this pattern to a GHE host would require plumbing a host through
 * repo resolution end-to-end (lib/repo-source.mjs, lib/cli.mjs, snapshot/
 * state-file naming), which is out of scope for F4's file list. On GHE a
 * check row still carries `detailsUrl`, just never `runId`/`jobId` --
 * indistinguishable here from an unsupported (non-Actions) check app.
 *
 * Returns null (not runId/jobId: null) when the URL is absent, malformed, on
 * another host, or not an Actions run/job URL, so `buildChecks` can omit the
 * keys entirely rather than adding a `null`-valued field that would make an
 * unparsed row differ from a row that simply has no URL -- both must fingerprint
 * identically, or delta ids would churn for a non-change.
 */
export function parseActionsRunJob(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const match = ACTIONS_RUN_JOB_PATH.exec(parsed.pathname);
  if (!match) return null;
  return { runId: match[1], jobId: match[2] };
}

/**
 * Sort normalized CI check/status rows deterministically, independent of the
 * order GitHub's rollup happens to return them in. This is what lets the
 * checks[] array enter the content-addressed delta id directly (see
 * `deltaIdentity`) without GitHub's own ordering churn producing phantom ids.
 *
 * Also parses each row's `detailsUrl` into `runId`/`jobId` (see
 * `parseActionsRunJob`) when recognizable. This happens after computing the
 * sort key, which never reads `runId`/`jobId`, so the added fields cannot
 * perturb the deterministic order.
 */
export function buildChecks(rows = []) {
  return sortRows(rows, (row) => `${row.name}:${row.kind}:${row.status}:${row.conclusion}`).map(
    (row) => {
      const parsed = parseActionsRunJob(row.detailsUrl);
      return parsed ? { ...row, runId: parsed.runId, jobId: parsed.jobId } : row;
    },
  );
}

/**
 * Sort normalized review rows deterministically. Every row always carries an
 * `id`, so it participates in the sort key as the final tiebreaker.
 */
export function buildReviews(rows = []) {
  return sortRows(
    rows,
    (row) => `${row.author}:${row.submittedAt}:${row.state}:${row.commit}:${row.id}`,
  );
}

/**
 * Sort normalized review-thread rows deterministically by identity + resolution
 * state. Rows without an id are dropped upstream (see lib/gh.mjs); they cannot
 * be told apart across ticks anyway.
 */
export function buildThreads(rows = []) {
  return sortRows(
    (rows ?? []).filter((row) => row?.id),
    (row) => `${row.id}:${row.resolved}`,
  );
}

/**
 * Build the stable subset of a pull request used for delta detection.
 *
 * Large fields such as comment/review bodies are deliberately excluded; the
 * detector stores only enough signal to classify state, CI, review,
 * mergeability, comment-count, and head-SHA changes. Every value here is
 * already normalized (lowercase enums, renamed fields) by lib/gh.mjs, so this
 * layer only assembles and deterministically sorts the row arrays.
 */
export function prFingerprint(pr) {
  return {
    state: pr.state,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft ?? false,
    headSha: pr.headSha ?? '',
    baseRef: pr.baseRef ?? '',
    mergeable: pr.mergeable ?? 'unknown',
    mergeStateStatus: pr.mergeStateStatus ?? 'unknown',
    reviewDecision: pr.reviewDecision ?? 'none',
    checks: buildChecks(pr.checks),
    reviews: buildReviews(pr.reviews),
    threads: buildThreads(pr.threads),
    conversationComments: pr.conversationComments ?? 0,
    reviewComments: pr.reviewComments ?? 0,
    recentComments: pr.recentComments ?? [],
    labels: (pr.labels ?? []).map((l) => l.name).sort(),
    assignees: [...(pr.assignees ?? [])].sort(),
    reviewRequests: [...(pr.reviewRequests ?? [])].sort(),
  };
}

/**
 * Build the stable subset of an issue used for delta detection.
 *
 * Labels are sorted before storage so GitHub API ordering does not change the
 * snapshot fingerprint.
 */
export function issueFingerprint(issue) {
  return {
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: (issue.labels ?? []).map((l) => l.name).sort(),
    assignees: [...(issue.assignees ?? [])].sort(),
    conversationComments: issue.conversationComments ?? 0,
    recentComments: issue.recentComments ?? [],
  };
}

// v1 had a `comparableFingerprint` drop-list here (14 keys) plus an
// `ADDITIVE_COMPARED_FIELDS` upgrade-compat list, both needed because a single
// flat object mixed compared fields, detail-only mirrors, and detector
// bookkeeping. Schema v2's three-section item shape (fingerprint / context /
// meta -- see lib/snapshot.mjs) removes the need for either: `fingerprint` is
// exactly the compared fields, nothing to drop, and there is no legacy
// snapshot to stay compatible with. R2 additionally removed the opaque
// ci/reviews/threadDigest digests and their summary mirrors: checks/reviews/
// threads are now the sole, legible, compared representation.

/**
 * Recursively key-sort an object so JSON serialization is order-independent.
 *
 * GitHub API key ordering must never change a fingerprint hash or a delta id.
 */
export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

// `deltaIdentity` runs at two different points against two different shapes
// of the same value: the CLI's report-assembly layer calls it immediately
// after lib/detect.mjs returns, while `to`/`from` are still the full
// `{fingerprint, context, meta}` snapshot item; any other caller holding a
// persisted delta (a JSON report, a durable log record, `gh-delta explain`)
// only ever has the public `to`/`from` shape -- the bare fingerprint (see
// lib/cli.mjs's strip step, right before a delta reaches the durable log,
// enrichment, outpost, and the report). This extracts the fingerprint from
// either shape so `deltaId(deltaIdentity(repo, delta))` is a stable, callable
// round-trip on a delta regardless of which side of that strip it comes from.
function fingerprintOf(value) {
  return value?.fingerprint ?? value ?? null;
}

/**
 * Build the identity object hashed into a delta's content-addressed `id`.
 *
 * When `to` is present the entity was observed this fetch, so identity keys on
 * the resulting observed state: `{ repo, entity, number, to }`, where `to` is
 * the compared-fields-only fingerprint (see lib/snapshot.mjs), never `context`
 * or `meta`. Because the fingerprint (including GitHub's `updatedAt` /
 * `headSha`) is a property of the observation and not of the observer's
 * history, two monitors that see the same current GitHub state emit the same
 * id — cross-monitor idempotency.
 *
 * When `to` is null (the `missing` / `still-missing` / `presumed-deleted`
 * lifecycle) there is no observed state, so identity keys on the last-seen
 * `from` fingerprint plus `classes` and `missingTicks` — the fields that
 * distinguish the three missing stages of the same object.
 *
 * `monitorId`, the report `detectedAt`, `title`, and any derived display
 * fields are deliberately excluded: the id addresses the observed change,
 * not the observer.
 */
export function deltaIdentity(repo, delta) {
  const { entity, number } = delta;
  if (delta.to != null) {
    return {
      repo,
      entity,
      number,
      to: fingerprintOf(delta.to),
      ...(delta.staleAt ? { staleAt: delta.staleAt } : {}),
    };
  }
  return {
    repo,
    entity,
    number,
    from: fingerprintOf(delta.from),
    classes: delta.classes,
    missingTicks: delta.missingTicks,
  };
}

/**
 * Return the full sha256 hex (64 chars) of a canonicalized delta identity.
 *
 * Ids are compared, not typed, so favour collision headroom over brevity. Pair
 * with `deltaIdentity()` at the report-assembly layer where `repo` is in scope.
 */
export function deltaId(identity) {
  return sha256(JSON.stringify(stableValue(identity)));
}
