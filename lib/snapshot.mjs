// Snapshot filesystem boundary. Missing snapshots seed a baseline; corrupt JSON is an error.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function snapshotPath(repo, branch, baseDir) {
  return `${baseDir}/${slug(repo)}-${slug(branch)}.json`;
}

export function readSnapshot(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) throw new Error(`invalid snapshot JSON at ${path}: ${err.message}`);
    throw err;
  }
}

export function writeSnapshotAtomic(path, data, deps = {}) {
  const fs = deps.fs ?? { mkdirSync, writeFileSync, renameSync };
  const uniqueSuffix = deps.uniqueSuffix ?? (() => `${process.pid}.${Date.now()}.${randomUUID()}`);
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${uniqueSuffix()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path); // atomic on POSIX within one filesystem
}
