import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const markdown = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);
const packageFiles = new Set(
  JSON.parse(
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--cache', '.npm-cache'],
      { cwd: root, encoding: 'utf8' },
    ),
  )[0].files.map((file) => file.path),
);
const published = (path) => packageFiles.has(path);

// Only prose links count: code fences contain literal sample Markdown and shell syntax.
function prose(text) {
  let fence;
  return text
    .split('\n')
    .filter((line) => {
      const match = /^\s*(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
        return false;
      }
      return !fence;
    })
    .join('\n');
}

function anchors(text) {
  const ids = new Set([...text.matchAll(/<a\s+id="([^"]+)"/g)].map((match) => match[1]));
  const counts = new Map();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]
      .toLowerCase()
      .replace(/`([^`]+)`|<[^>]*>/g, (_, code) => code ?? '')
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
      .replaceAll(' ', '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(`${base}${count ? `-${count}` : ''}`);
  }
  return ids;
}

test('Markdown links resolve, including section anchors and independently distributed docs', () => {
  const failures = [];
  for (const path of markdown) {
    const text = prose(readFileSync(resolve(root, path), 'utf8'));
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const url = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/')) continue;
      const [filename, fragment] = url.split('#');
      let target = filename
        ? resolve(root, dirname(path), decodeURIComponent(filename))
        : resolve(root, path);
      if (!existsSync(target)) {
        failures.push(`${path}: missing ${url}`);
        continue;
      }
      if (statSync(target).isDirectory()) target = resolve(target, 'README.md');
      const targetPath = relative(root, target);
      if (fragment && target.endsWith('.md')) {
        assert.ok(existsSync(target), `${path}: directory link ${url} needs README.md`);
        const ids = anchors(prose(readFileSync(target, 'utf8')));
        if (!ids.has(decodeURIComponent(fragment))) failures.push(`${path}: missing anchor ${url}`);
      }
      if (published(path) && !published(targetPath) && targetPath !== 'LICENSE') {
        failures.push(`${path}: npm omits local link ${url}; use a repository URL`);
      }
      if (path.startsWith('skills/gh-delta/') && !targetPath.startsWith('skills/gh-delta/')) {
        failures.push(`${path}: standalone skill cannot reach ${url}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('all maintained topic pages and indexes ship in npm', () => {
  // The existing research authoring template is deliberately excluded by its .npmignore.
  for (const path of markdown.filter(
    (path) =>
      /^(docs\/|skills\/gh-delta\/)/.test(path) && path !== 'docs/entities-research/_template.md',
  )) {
    assert.ok(published(path), `${path} is missing from package.json files`);
  }
});
