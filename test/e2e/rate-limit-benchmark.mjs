#!/usr/bin/env node
// Manual GraphQL quota micro-benchmark: measures the real `rateLimit.cost` of
// every schema-v2 query against a live repository. It is NOT a test -- it
// costs real GraphQL quota and needs network + an authenticated `gh` -- so it
// is gated behind GH_DELTA_E2E_RUN, the same convention playground-e2e.mjs
// uses, and is never invoked by `npm run check` / `node --test`.
//
// Run it with:
//   GH_DELTA_E2E_RUN=1 node ./test/e2e/rate-limit-benchmark.mjs [owner/name]
//
// It prints one markdown table row per measured query so the numbers can be
// pasted straight into docs/contract.md's cost table (task E0's job, not
// this harness's -- this script only measures, it does not edit docs).
import { fetchEnrichment, fetchIssues, fetchPRs, fetchPRsByNumber } from '../../lib/gh.mjs';

function row(query, rateLimit, note) {
  const cost = rateLimit?.cost ?? 'n/a';
  console.log(`| ${query} | ${cost} | ${note} |`);
}

async function main() {
  const repo = process.argv[2] ?? process.env.GH_DELTA_BENCHMARK_REPO ?? 'diegomarino/gh-delta';
  console.log(`Measuring against ${repo} (this spends real GraphQL quota).\n`);
  console.log('| query | cost | note |');
  console.log('| --- | --- | --- |');

  const prs = fetchPRs(repo, { horizonCutoff: null });
  row('PR observation (open-only page)', prs.rateLimit, `${prs.rows.length} open PR(s)`);

  const issues = fetchIssues(repo, { horizonCutoff: null });
  row(
    'issue observation (open-only page)',
    issues.rateLimit,
    `${issues.rows.length} open issue(s)`,
  );

  if (prs.rows.length) {
    const targeted = fetchPRsByNumber(repo, [prs.rows[0].number]);
    row(
      'targeted PR-by-number (economical watch)',
      targeted.rateLimit,
      `PR #${prs.rows[0].number}`,
    );
  } else {
    console.log('| targeted PR-by-number (economical watch) | skipped | no open PR to target |');
  }

  // Enrichment cost depends on a real node id (a review, comment, or review
  // thread), which this harness cannot discover generically. Pass one
  // explicitly to measure it:
  const reviewId = process.env.GH_DELTA_BENCHMARK_REVIEW_ID;
  if (reviewId) {
    const enrichment = fetchEnrichment('review', [reviewId]);
    row('enrichment (review, 1 id)', enrichment.rateLimit, `id=${reviewId}`);
  } else {
    console.log(
      '| enrichment (review/comments/threads) | skipped | set GH_DELTA_BENCHMARK_REVIEW_ID (etc.) to measure |',
    );
  }
}

if (process.env.GH_DELTA_E2E_RUN === '1') {
  await main();
}
