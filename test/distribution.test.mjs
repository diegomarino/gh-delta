import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, readFileSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = new URL('../', import.meta.url);
const path = (relative) => new URL(relative, root);

test('agent skill has valid structured frontmatter and generated flags in the package', async () => {
  const skill = readFileSync(path('skills/gh-delta/SKILL.md'), 'utf8');
  const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---\n/.exec(skill)?.groups?.yaml;
  assert.ok(frontmatter, 'SKILL.md has YAML frontmatter');
  await prettier.format(frontmatter, { parser: 'yaml' });
  const fields = Object.fromEntries(
    frontmatter.split('\n').map((line) => {
      const match = /^(?<key>[a-z]+): (?<value>.+)$/.exec(line);
      assert.ok(match, `frontmatter field is key: value: ${line}`);
      return [match.groups.key, match.groups.value];
    }),
  );
  assert.equal(fields.name, 'gh-delta');
  assert.equal(fields.license, 'MIT');
  assert.match(fields.description, /^(".*"|'.*')$/);
  const description = fields.description.startsWith('"')
    ? JSON.parse(fields.description)
    : fields.description.slice(1, -1).replaceAll("''", "'");
  assert.ok(description.length <= 200);
  assert.match(skill, /references\/flags\.md/);
  assert.match(readFileSync(path('skills/gh-delta/references/flags.md'), 'utf8'), /Generated/);
  const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'));
  assert.ok(pkg.files.includes('.claude-plugin'));
});

test('generated skill flags are synchronized with help metadata', () => {
  execFileSync(process.execPath, ['tools/skill/generate-flags.mjs', '--check'], {
    cwd: new URL('../', import.meta.url),
    stdio: 'pipe',
  });
});

test('agent decision guide gives wait its actual exit and format boundaries', () => {
  const skill = readFileSync(path('skills/gh-delta/SKILL.md'), 'utf8');
  assert.match(skill, /`10`\s+until\/already-satisfied/);
  assert.match(skill, /`0`\s+timeout\/signal/);
  assert.match(skill, /`1`\s+retryable failure/);
  assert.match(skill, /`2`\s+fix\s+configuration/);
  assert.match(skill, /ordinary detector output/);
  assert.match(skill, /`wait`.*JSON only/);
});

test('agent skill routes real monitoring workflows instead of restating flags', () => {
  const skill = readFileSync(path('skills/gh-delta/SKILL.md'), 'utf8');
  assert.match(skill, /current GitHub repository|current checkout/i);
  assert.match(skill, /PRs?.*issues?.*both.*search|scope/i);
  assert.match(skill, /references\/patterns\.md/);
  assert.match(skill, /references\/troubleshooting\.md/);

  const patterns = readFileSync(path('skills/gh-delta/references/patterns.md'), 'utf8');
  assert.match(patterns, /gh repo view/);
  assert.match(patterns, /watch add/);
  assert.match(patterns, /--watch-dir/);
  assert.match(patterns, /--number.*post-fetch/is);
  assert.match(patterns, /report\.logFile|logFile.*report/is);
  assert.match(patterns, /one cursor per consumer/i);
  assert.match(patterns, /--stale-after/);
  assert.match(patterns, /AGENT[\s\S]+PURPOSE[\s\S]+SCENARIO_ROOT/);
  assert.match(patterns, /monitor-id.*agent.*purpose/is);
  assert.match(patterns, /mkdir -p "\$STATE_DIR" "\$REPORT_DIR"/);
  assert.match(patterns, /gh-delta doctor[\s\S]+--monitor-id "\$MONITOR_ID"/);
  assert.match(patterns, /OWNER\.md/);
  assert.match(patterns, /stop command/i);
  assert.match(patterns, /retire.*scenario/is);
  assert.match(patterns, /mv .*ARCHIVE/);
  assert.match(patterns, /registry.*stale/is);

  const troubleshooting = readFileSync(
    path('skills/gh-delta/references/troubleshooting.md'),
    'utf8',
  );
  assert.match(troubleshooting, /HTTP 502/);
  assert.match(troubleshooting, /snapshot.*(?:not updated|unchanged)/is);
  assert.match(troubleshooting, /do not delete|never delete/i);
  assert.match(troubleshooting, /gh-delta doctor/);
  assert.match(troubleshooting, /githubstatus\.com/);
  assert.match(troubleshooting, /docs\/contract\.md/);
  assert.match(troubleshooting, /docs\/recipes\.md/);
  assert.match(troubleshooting, /docs\/troubleshooting\.md/);
});

test('README explains interactive and explicit Codex skill installation', () => {
  const readme = readFileSync(path('README.md'), 'utf8');
  assert.match(readme, /--skill gh-delta/);
  assert.match(readme, /--agent codex/);
  assert.match(readme, /--global/);
  assert.match(readme, /skills (?:list|ls).*--agent codex/);
});

test('gh extension shim is executable, guards Node, and identifies its channel', () => {
  accessSync(path('gh-delta'), constants.X_OK);
  const output = execFileSync(fileURLToPath(path('gh-delta')), ['--version'], { encoding: 'utf8' });
  assert.match(
    output,
    /^gh-delta \d+\.\d+\.\d+ \(gh extension\) https:\/\/github\.com\/diegomarino\/gh-delta\/releases\n$/,
  );
  assert.match(
    readFileSync(path('gh-delta'), 'utf8'),
    /GH_DELTA_CHANNEL='gh extension' exec node .*"\$@"/,
  );
});

test('Claude marketplace metadata points at the root plugin', () => {
  const marketplace = JSON.parse(readFileSync(path('.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'gh-delta');
  assert.equal(marketplace.plugins[0].name, 'gh-delta');
  assert.equal(marketplace.plugins[0].source, '.');
  const plugin = JSON.parse(readFileSync(path('.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'gh-delta');
  const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
});

test('release metadata and CI enforce distributable agent and extension installs', () => {
  const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8'));
  assert.match(pkg.scripts['release:check'], /npm run skill:check/);
  const releasePlease = JSON.parse(readFileSync(path('release-please-config.json'), 'utf8'));
  assert.deepEqual(releasePlease.packages['.']['extra-files'], [
    { type: 'json', path: '.claude-plugin/plugin.json', jsonpath: '$.version' },
  ]);
  const ci = readFileSync(path('.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /name: Verify skill discovery\n\s+if: matrix\.node-version == '20\.x'/);
  assert.match(ci, /listing="\$\(npx skills add \.\/ --list 2>&1\)"/);
  assert.match(ci, /grep -Fq -- 'gh-delta'/);
  assert.match(ci, /skill discovery did not list gh-delta/);
  assert.match(ci, /distribution:/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /GH_CONFIG_DIR/);
  assert.match(ci, /gh extension install \./);
  assert.match(ci, /gh delta --version/);
  assert.match(
    readFileSync(path('.github/workflows/release-please.yml'), 'utf8'),
    /npm run skill:check/,
  );
  assert.match(
    readFileSync(path('docs/release-checklist.md'), 'utf8'),
    /\.claude-plugin\/plugin\.json/,
  );
  const readme = readFileSync(path('README.md'), 'utf8');
  assert.match(readme, /npx skills add diegomarino\/gh-delta/);
  assert.match(readme, /gh extension install diegomarino\/gh-delta/);
});
