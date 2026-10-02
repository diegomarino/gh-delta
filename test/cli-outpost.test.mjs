// CLI contract tests: outpost signing, secrets, payloads, and delivery IDs.
process.env.GH_DELTA_NO_REGISTRY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePr, item, openFp, NOOP_LOCK_DEPS, RATE_LIMIT, deps } from './helpers/cli-fixtures.mjs';
import { run, runCommand } from '../lib/cli.mjs';
import { outpostSignature } from '../lib/outpost.mjs';

// Standard Webhooks (https://www.standardwebhooks.com/) worked example,
// independently verified: id, timestamp, body, and secret are fixed
// literals, and the expected signature is a fixed literal too -- this must
// catch a construction bug (wrong field order, wrong separator, hex instead
// of base64, ms instead of seconds) that a round-trip through outpostSignature
// itself could never catch.
test('outpostSignature matches a fixed Standard Webhooks v1 test vector', () => {
  assert.equal(
    outpostSignature(
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      '1614265330',
      '{"test": 2432232314}',
      'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    ),
    'v1,ELhqG0Ku1gwOc1f4jyKdp3SFGFLAOdJ9bvpWLciCakI=',
  );
});

test('postOutpost signs the exact serialized body with Standard Webhooks headers', async () => {
  const { postOutpost, outpostSignature: sign } = await import('../lib/outpost.mjs');
  const payload = { type: 'gh-delta.delta', deliveryId: 'gh-delta.delivery.v1:o/r:m:pr:1:x:t' };
  let sent;

  await postOutpost('https://example.com/hook', payload, {
    secret: 'Jefe',
    fetchImpl: async (_url, options) => {
      sent = options;
      return { ok: true, status: 202 };
    },
  });

  const expectedBody =
    '{"type":"gh-delta.delta","deliveryId":"gh-delta.delivery.v1:o/r:m:pr:1:x:t"}';
  assert.equal(sent.body, expectedBody, 'the signed bytes must be the bytes sent');
  assert.equal(sent.headers['webhook-id'], payload.deliveryId);
  assert.match(sent.headers['webhook-timestamp'], /^\d+$/);
  assert.equal(
    sent.headers['webhook-signature'],
    sign(payload.deliveryId, sent.headers['webhook-timestamp'], expectedBody, 'Jefe'),
  );
});

test('--outpost-secret validates its environment-variable name before repo derivation', () => {
  let derived = false;
  const { code, report } = run(['--outpost-secret', 'not-valid'], {
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      derived = true;
      throw new Error('must not derive');
    },
  });

  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-secret must name an environment variable/);
  assert.equal(derived, false);
});

test('--outpost-secret reads the injected environment and does not leak its value', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item({
          state: 'open',
          updatedAt: '2026-07-01T10:00:00Z',
          isDraft: false,
          ci: 'x',
          review: 'review_required',
          reviews: 'x',
          mergeable: 'unknown',
          head: 'sha1',
        }),
      },
      issue: {},
    },
  });
  d.fetchPRsByNumber = () => ({
    rows: [{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }],
    rateLimit: RATE_LIMIT,
  });
  let sent;
  // This overwrites the whole `env` object, so it must re-include the
  // module-level GH_DELTA_NO_REGISTRY guard (line 6) itself -- otherwise this
  // one resolved detector tick writes a real breadcrumb into the developer's
  // ~/.local/state/gh-delta/registry.
  d.env = { OUTPOST_SECRET: 'not-in-report', GH_DELTA_NO_REGISTRY: '1' };
  d.outpostFetch = async (_url, options) => {
    sent = options;
    return { ok: true, status: 202 };
  };

  const result = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
      '--outpost-secret',
      'OUTPOST_SECRET',
    ],
    d,
  );

  assert.match(sent.headers['webhook-signature'], /^v1,[A-Za-z0-9+/]+=*$/);
  assert.match(sent.headers['webhook-timestamp'], /^\d+$/);
  assert.equal(sent.headers['webhook-id'], JSON.parse(sent.body).deliveryId);
  assert.doesNotMatch(JSON.stringify(result), /not-in-report/);
  assert.doesNotMatch(sent.body, /not-in-report/);
});

test('--outpost-secret requires an outpost URL and a non-empty injected value', () => {
  const missingUrl = run(['--repo', 'o/r', '--outpost-secret', 'OUTPOST_SECRET'], {
    now: () => '2026-07-01T12:00:00Z',
    env: { OUTPOST_SECRET: 'value' },
  });
  assert.equal(missingUrl.code, 2);
  assert.match(missingUrl.report.error, /requires --outpost-url/);

  const emptyValue = run(
    ['--repo', 'o/r', '--outpost-url', 'https://example.com', '--outpost-secret', 'OUTPOST_SECRET'],
    { now: () => '2026-07-01T12:00:00Z', env: { OUTPOST_SECRET: '' } },
  );
  assert.equal(emptyValue.code, 2);
  assert.match(emptyValue.report.error, /OUTPOST_SECRET.*unset or empty/);
});

test('unsigned postOutpost sends no Standard Webhooks headers and keeps the exact body bytes', async () => {
  const { postOutpost } = await import('../lib/outpost.mjs');
  let sent;
  await postOutpost(
    'https://example.com/hook',
    { a: 1 },
    {
      fetchImpl: async (_url, options) => {
        sent = options;
        return { ok: true, status: 202 };
      },
    },
  );
  assert.deepEqual(sent.headers, { 'Content-Type': 'application/json' });
  assert.equal(sent.body, '{"a":1}');
});

test('gh-delta sends outpost payloads with monitor id after the snapshot write', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 202 };
  };

  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/gh-delta',
    ],
    d,
  );

  assert.equal(code, 10);
  assert.equal(d.writes, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://example.com/gh-delta');
  assert.equal(posts[0].body.type, 'gh-delta.delta');
  assert.equal(posts[0].body.monitorId, 'main');
  assert.equal(posts[0].body.delta.branch, undefined);
  assert.equal(
    posts[0].body.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:merged:2026-07-01T12:00:00Z',
  );
});

test('gh-delta rejects invalid --outpost-url before fetching GitHub', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  let fetches = 0;
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'file:///tmp/outpost.json',
    ],
    {
      ...NOOP_LOCK_DEPS,
      fetchPRs: () => {
        fetches++;
        throw new Error('should not fetch');
      },
      fetchIssues: () => ({ rows: [], rateLimit: RATE_LIMIT }),
      readSnapshot: () => ({ pr: {}, issue: {} }),
      writeSnapshotAtomic: () => {
        throw new Error('should not write');
      },
      now: () => '2026-07-01T12:00:00Z',
    },
  );

  assert.equal(code, 2);
  assert.equal(fetches, 0);
  assert.match(report.error, /--outpost-url must use http: or https:/);
});

test('config validation precedes repo derivation: an invalid --outpost-url short-circuits before resolveRepo runs', () => {
  const d = {
    fetchPRs: () => {
      throw new Error('should not fetch');
    },
    fetchIssues: () => {
      throw new Error('should not fetch');
    },
    now: () => '2026-07-01T12:00:00Z',
    resolveRepo: () => {
      throw new Error('resolver must not run');
    },
  };
  // --repo is deliberately omitted: resolveRepo would normally run and could
  // shell out to `gh` (network). An invalid --outpost-url is a deterministic,
  // repo-independent config error and must be reported before any GitHub
  // access is attempted.
  const { code, report } = run(
    ['--state-file', '/tmp/x.json', '--outpost-url', 'file:///tmp/outpost.json'],
    d,
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-url must use http: or https:/);
});

test('outpost payload copies watch.labels from the source delta', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' },
    delta: {
      entity: 'pr',
      number: 42,
      context: { title: 'x' },
      classes: ['new-comments'],
      watch: { labels: { thread: 't-0004' } },
    },
  });
  assert.equal(payload.delta.watch.labels.thread, 't-0004');
});

test('outpost deliveryId is order-independent across class permutations', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const report = { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' };
  const a = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      context: { title: 'x' },
      classes: ['review-changed', 'ci-changed'],
    },
  });
  const b = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      context: { title: 'x' },
      classes: ['ci-changed', 'review-changed'],
    },
  });
  assert.equal(a.deliveryId, b.deliveryId);
  assert.equal(
    a.deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:ci-changed+review-changed:2026-07-01T12:00:00Z',
  );
});

test('outpost deliveryId changes across detector timestamps for the same delta', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = { entity: 'pr', number: 42, context: { title: 'x' }, classes: ['merged'] };
  const first = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  const second = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:01Z' },
    delta,
  });

  assert.notEqual(first.deliveryId, second.deliveryId);
});

test('outpost delta.id changes across different observed states while deliveryId does not (regression: delta.id is the dedupe key, not deliveryId)', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const report = { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' };
  // Same PR, same class set (ci-changed), two successive observed states —
  // e.g. CI went red, then green. A receiver that dedupes by deliveryId would
  // silently drop the second one; delta.id is the one field safe to dedupe by.
  const first = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      context: { title: 'x' },
      classes: ['ci-changed'],
      to: item({ state: 'open', ciRollup: 'red' }),
    },
  });
  const second = buildOutpostPayload({
    report,
    delta: {
      entity: 'pr',
      number: 42,
      context: { title: 'x' },
      classes: ['ci-changed'],
      to: item({ state: 'open', ciRollup: 'green' }),
    },
  });
  assert.equal(first.deliveryId, second.deliveryId);
  assert.notEqual(first.delta.id, second.delta.id);
});

test('outpost delta.id is stable across runs and across monitorId values for the same observed change, while deliveryId is not', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = {
    entity: 'pr',
    number: 42,
    context: { title: 'x' },
    classes: ['merged'],
    to: item({ state: 'merged' }),
  };
  const a = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  const b = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-08-01T00:00:00Z' },
    delta,
  });
  const c = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'other-monitor', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.equal(a.delta.id, b.delta.id);
  assert.equal(a.delta.id, c.delta.id);
  // deliveryId includes monitorId, so it diverges where delta.id doesn't.
  assert.notEqual(a.deliveryId, c.deliveryId);
});

test('two monitors observing the same change produce the same delta.id but a different deliveryId', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const delta = {
    id: 'f'.repeat(64),
    repo: 'o/r',
    entity: 'pr',
    number: 42,
    context: { title: 'x' },
    classes: ['merged'],
    to: item({ state: 'merged' }),
  };
  const a = buildOutpostPayload({
    report: { monitorId: 'monitor-a', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  const b = buildOutpostPayload({
    report: { monitorId: 'monitor-b', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.equal(a.delta.id, b.delta.id);
  assert.notEqual(a.deliveryId, b.deliveryId);
});

test('outpost payload has exactly the documented top-level key set, and embeds the report delta verbatim (no root-level field duplication)', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  // Already CLI-shaped (repo/summary/changed stamped, `to` stripped to the
  // bare fingerprint) -- the normal case, matching what a real report.deltas
  // entry looks like. See the un-normalized detectDeltas() case below for the
  // documented direct-embedding path.
  const delta = {
    id: 'a'.repeat(64),
    repo: 'o/r',
    entity: 'pr',
    number: 42,
    context: { title: 'x', headRefName: 'feature' },
    classes: ['merged'],
    seq: 7,
    summary: { state: 'merged' },
    changed: {},
    from: null,
    to: { state: 'merged', labels: [] },
  };
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' },
    delta,
  });
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['type', 'schemaVersion', 'deliveryId', 'seq', 'monitorId', 'detectedAt', 'delta'].sort(),
  );
  assert.deepEqual(payload.delta, delta, 'the embedded delta must be the report delta, unmodified');
  assert.equal(payload.seq, 7);
});

test('outpost payload seq is null (not omitted) when the delta carries no journal record', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const payload = buildOutpostPayload({
    report: { repo: 'o/r', monitorId: 'main', detectedAt: '2026-07-01T12:00:00Z' },
    delta: { entity: 'issue', number: 1, context: { title: 'x' }, classes: ['new-comments'] },
  });
  assert.equal(payload.seq, null);
  assert.equal(Object.hasOwn(payload, 'seq'), true);
});

test('outpost mirrors optional transient enrichment on the embedded delta, verbatim', async () => {
  const { buildOutpostPayload } = await import('../lib/outpost.mjs');
  const base = {
    report: { repo: 'o/r', monitorId: 'main', detectedAt: 'now' },
    delta: { entity: 'issue', number: 1, context: { title: 'x' }, classes: ['new-comments'] },
  };
  assert.equal(Object.hasOwn(buildOutpostPayload(base).delta, 'enrichment'), false);
  const enrichment = {
    comments: [{ id: 'C1', author: 'a', createdAt: 'now', body: 'hi', mentions: [] }],
  };
  assert.deepEqual(
    buildOutpostPayload({ ...base, delta: { ...base.delta, enrichment } }).delta.enrichment,
    enrichment,
  );
});

test('duplicate --outpost-url uses last-wins like every other flag', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const existing = {
    pr: {
      42: item(openFp),
    },
    issue: {},
  };
  const d = deps([[{ ...basePr, conversationComments: 2, updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing,
  });
  const posts = [];
  d.outpostFetch = async (url) => {
    posts.push(url);
    return { ok: true, status: 202 };
  };
  const { code } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://first.example',
      '--outpost-url',
      'https://second.example',
    ],
    d,
  );
  assert.equal(code, 10); // a real delta fired, and it was delivered
  assert.ok(posts.length > 0);
  // validateOutpostUrl normalizes via `new URL(...).href`, which appends a
  // trailing slash to a bare-origin URL; match on origin to stay robust to that.
  assert.ok(posts.every((url) => new URL(url).origin === 'https://second.example'));
});

test('sendOutposts stops after the configured max payload count', async () => {
  const { sendOutposts } = await import('../lib/outpost.mjs');
  const report = {
    repo: 'o/r',
    monitorId: 'main',
    at: '2026-07-01T12:00:00Z',
    deltas: [
      { entity: 'pr', number: 1, title: 'one', classes: ['new'] },
      { entity: 'pr', number: 2, title: 'two', classes: ['new'] },
    ],
  };
  const posts = [];
  const { warnings } = await sendOutposts({
    outpostUrl: 'https://example.com',
    report,
    maxPosts: 1,
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    },
  });

  assert.equal(posts.length, 1);
  assert.deepEqual(warnings, [
    { label: 'outpost', reason: 'skipped 1 delta(s) after max outpost post count 1' },
  ]);
});

test('outpost warnings land inside the JSON report, not on stderr', async () => {
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  d.outpostFetch = async () => ({ ok: false, status: 500 });
  const { code, output, stderr } = await runCommand(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(stderr, '');
  const report = JSON.parse(output);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0].reason, /HTTP 500/);
});

test('--outpost-max-posts caps delivery from the CLI', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const existing = { pr: {}, issue: {} };
  const d = deps([[basePr, { ...basePr, number: 43, title: 'second' }]], { existing });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, warnings } = await runWithOutpost(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-url',
      'https://example.com/hook',
      '--outpost-max-posts',
      '1',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.equal(posts.length, 1);
  assert.match(warnings[0].reason, /skipped 1 delta/);
});

test('non-numeric outpost flags are config errors (exit 2)', () => {
  const { code, report } = run(
    [
      '--repo',
      'o/r',
      '--monitor-id',
      'main',
      '--state-file',
      '/tmp/x.json',
      '--outpost-timeout-ms',
      'soon',
    ],
    { now: () => '2026-07-01T12:00:00Z' },
  );
  assert.equal(code, 2);
  assert.equal(report.kind, 'config');
  assert.match(report.error, /--outpost-timeout-ms/);
});

test('mixed-case --repo shares one snapshot and one deliveryId space', async () => {
  const { runWithOutpost } = await import('../lib/cli.mjs');
  const d = deps([[{ ...basePr, state: 'merged', updatedAt: '2026-07-01T11:00:00Z' }]], {
    existing: {
      pr: {
        42: item(openFp),
      },
      issue: {},
    },
  });
  const posts = [];
  d.outpostFetch = async (url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const { code, report } = await runWithOutpost(
    [
      '--repo',
      'O/R',
      '--monitor-id',
      'main',
      '--state-dir',
      '/tmp/state',
      '--outpost-url',
      'https://example.com/hook',
    ],
    d,
  );
  assert.equal(code, 10);
  assert.deepEqual(report.repos, ['o/r']);
  assert.equal(d.readPath, '/tmp/state/repo-o%2Fr__monitor-main__pr-issue.json');
  assert.equal(
    posts[0].deliveryId,
    'gh-delta.delivery.v1:o/r:main:pr:42:merged:2026-07-01T12:00:00Z',
  );
  assert.equal(posts[0].delta.repo, 'o/r');
});
