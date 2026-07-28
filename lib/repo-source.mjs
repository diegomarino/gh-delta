// lib/repo-source.mjs
// Resolves owner/name from the ambient git context when --repo is omitted.
// Shells out like lib/gh.mjs (execFileSync, no shell, injectable exec) but with
// the OPPOSITE failure policy: a missing remote / non-repo cwd is a routine
// silent decline, not an error.

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
