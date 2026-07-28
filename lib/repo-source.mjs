// lib/repo-source.mjs
// Resolves owner/name from the ambient git context when --repo is omitted.
// Shells out like lib/gh.mjs (execFileSync, no shell, injectable exec) but with
// the OPPOSITE failure policy: a missing remote / non-repo cwd is a routine
// silent decline, not an error.
import { execFileSync } from 'node:child_process';

// The only forge whose PR/issue contract gh-delta implements today is GitHub.
// Adding GitLab/Bitbucket later = add a descriptor here + a fetch adapter; the
// resolution flow does not change.
const GITHUB = {
  id: 'github',
  // github.com only. GitHub Enterprise hosts and SSH-config host aliases are
  // arbitrary and are resolved through the `gh` fallback, not by URL matching.
  matchesHost: (host) => host.toLowerCase() === 'github.com',
};
const FORGES = [GITHUB];

export function identifyForge(host) {
  return FORGES.find((forge) => forge.matchesHost(host)) ?? null;
}

export function parseRemoteUrl(url) {
  const trimmed = String(url ?? '').trim();
  let host, pathname;
  if (/^(https?|ssh):\/\//i.test(trimmed)) {
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      return null;
    }
    host = u.hostname; // hostname, NOT host: host keeps the :port and breaks matching
    pathname = u.pathname;
  } else {
    // scp-like shorthand: [user@]host:owner/name(.git)?  (no scheme, not a URL)
    const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!m) return null;
    host = m[1];
    pathname = m[2];
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '');
  }
  // GitHub slugs are always exactly owner/name; 0, 1, or 3+ segments decline.
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { host, owner: segments[0], name: segments[1] };
}

const GIT_TIMEOUT_MS = 5000;

const defaultExec = (cmd, args, { timeoutMs } = {}) =>
  // Raw throw (err.code preserved) so the resolver can tell a timeout from a
  // plain non-zero exit — the opposite policy from lib/gh.mjs's wrapping exec.
  execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// A missing remote / non-repo cwd exits non-zero; treat that as "absent", null.
function gitRemoteRepo(exec, name) {
  let url;
  try {
    url = exec('git', ['remote', 'get-url', name], { timeoutMs: GIT_TIMEOUT_MS });
  } catch {
    return null;
  }
  const parsed = parseRemoteUrl(url);
  if (!parsed || !identifyForge(parsed.host)) return null;
  return `${parsed.owner}/${parsed.name}`;
}

function ghRepoView(exec, ghTimeoutMs) {
  let out;
  try {
    out = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      timeoutMs: ghTimeoutMs,
    });
  } catch (err) {
    // A timeout is transient (retryable).
    if (err?.code === 'ETIMEDOUT' || /timed out/i.test(String(err?.message)))
      return { status: 'failed', reason: String(err?.message ?? err) };
    // execFileSync errors carry .stderr (piped, per defaultExec above). Only a
    // genuine "nothing to derive here" is a permanent decline: no git repo at
    // all, or a git repo whose remotes don't point at a known GitHub host.
    // Everything else gh can fail with (network drop, API 5xx, rate limit,
    // auth) is transient and must stay retryable, not collapse into 'declined'.
    const stderr = String(err?.stderr ?? err?.message ?? '');
    if (/not a git repository|known github host/i.test(stderr)) return { status: 'declined' };
    return { status: 'failed', reason: stderr.trim() || String(err?.message ?? err) };
  }
  const slug = String(out).trim();
  return slug ? { status: 'found', slug } : { status: 'declined' };
}

export function resolveRepoFromGit({ exec = defaultExec, ghTimeoutMs } = {}) {
  const origin = gitRemoteRepo(exec, 'origin');
  const upstream = gitRemoteRepo(exec, 'upstream');
  const chosen = origin ?? upstream;
  if (chosen) {
    const warnings = [];
    if (origin && upstream && origin.toLowerCase() !== upstream.toLowerCase()) {
      warnings.push({
        label: 'repo',
        reason:
          `monitoring origin (${origin}); upstream resolves to a different repo ` +
          `(${upstream}) — pass --repo to choose explicitly`,
      });
    }
    return { status: 'found', repo: chosen, source: 'git-remote', warnings };
  }
  const gh = ghRepoView(exec, ghTimeoutMs);
  if (gh.status === 'found') return { status: 'found', repo: gh.slug, source: 'gh', warnings: [] };
  return gh; // 'declined' | 'failed'
}
