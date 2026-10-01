import { errorResult } from '../errors.mjs';
import {
  formatSniff,
  commandHelp,
  WATCH_OPTIONS,
  WATCH_ADD_OPTIONS,
  WATCH_SYNC_OPTIONS,
} from '../parse.mjs';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { validateRepo, validateMonitorId, defaultMonitorId } from '../../args.mjs';
import { resolveRepoFromLocalGit } from '../../repo-source.mjs';
import { selectedMonitorId } from '../config.mjs';
import { watchDirPath, addWatch, removeWatch, listWatch } from '../../watch.mjs';
import { canonicalLabels } from '../../watch-entry.mjs';
import { defaultStateDir } from '../../snapshot.mjs';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';
import { syncWatch, WatchDirBusyError } from '../../watch-sync.mjs';

function labelsFromArgs(tokens) {
  if (!tokens || tokens.length === 0) return undefined;
  const map = Object.create(null);
  for (const token of tokens) {
    const eq = typeof token === 'string' ? token.indexOf('=') : -1;
    if (eq <= 0 || token.indexOf('=', eq + 1) !== -1) throw new Error(`invalid label ${token}`);
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (Object.hasOwn(map, key)) throw new Error(`duplicate label key ${key}`);
    map[key] = value;
  }
  return canonicalLabels(map);
}

function readSyncInput(from, deps) {
  if (from === '-') {
    if (typeof deps.stdin === 'string') return deps.stdin;
    return readFileSync(0, 'utf8');
  }
  return readFileSync(from, 'utf8');
}

function syncFailure(err) {
  const raw = String(err.message ?? err);
  let message = `watch sync: ${raw}`;
  if (err?.committed === true) message = 'watch sync: committed but the report was not written';
  else if (raw.startsWith('watch sync')) message = raw;
  const transient =
    err?.committed === true ||
    err instanceof WatchDirBusyError ||
    err?.code === 'WATCH_DIR_BUSY' ||
    Number.isInteger(err?.errno);
  return { code: transient ? 1 : 2, format: 'json', stderrMessage: message, report: null };
}

function runWatchSync(argv, deps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const help = commandHelp(argv, 'gh-delta watch sync');
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    const parsed = parseArgs({ args: argv, options: WATCH_SYNC_OPTIONS, allowPositionals: true });
    values = { ...parsed.values, positionals: parsed.positionals };
  } catch (err) {
    return syncFailure(new Error(err.message));
  }
  if (values.positionals.length !== 0)
    return syncFailure(new Error('does not accept a positional item'));
  if (!values.from || !values['watch-dir'])
    return syncFailure(new Error('--from and --watch-dir are required'));
  let repo;
  if (values.repo !== undefined) {
    const validated = validateRepo(values.repo);
    if (!validated.ok) return syncFailure(new Error(validated.error));
    repo = validated.repo;
  }
  let text;
  try {
    text = readSyncInput(values.from, deps);
  } catch (err) {
    return syncFailure(err);
  }
  try {
    const result = syncWatch(values['watch-dir'], text, {
      now,
      allowEmpty: values['allow-empty'] === true,
      ...(repo ? { repo } : {}),
    });
    return {
      code: 0,
      format: 'json',
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'watch sync',
        added: result.added,
        removed: result.removed,
        updated: result.updated,
        unchanged: result.unchanged,
      },
    };
  } catch (err) {
    return syncFailure(err);
  }
}

function runWatch(argv, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const action = argv.shift();
  if (action === 'sync') return runWatchSync(argv, deps);
  if (!['add', 'rm', 'ls'].includes(action))
    return errorResult(
      'config',
      'watch requires add, rm, or ls',
      { at, command: 'watch' },
      formatSniff(argv),
    );
  const help = commandHelp(argv, `gh-delta watch ${action}`);
  if (help) return { code: 0, report: help, format: 'json' };
  let values;
  try {
    const parsed = parseArgs({
      args: argv,
      options: action === 'add' ? WATCH_ADD_OPTIONS : WATCH_OPTIONS,
      allowPositionals: true,
    });
    values = { ...parsed.values, positionals: parsed.positionals };
  } catch (err) {
    return errorResult('config', String(err), { at, command: 'watch' }, formatSniff(argv));
  }
  if (!['json', 'text'].includes(values.format))
    return errorResult('config', '--format must be json or text', { at, command: 'watch' }, 'json');
  const expected = action === 'ls' ? 0 : 1;
  if (values.positionals.length !== expected)
    return errorResult(
      'config',
      `watch ${action} requires exactly ${expected} item argument(s)`,
      { at, command: 'watch' },
      values.format,
    );
  let dir = values['watch-dir'];
  let scopedRepo;
  if (dir && values.repo !== undefined) {
    const validated = validateRepo(values.repo);
    if (!validated.ok)
      return errorResult('config', validated.error, { at, command: 'watch' }, values.format);
    scopedRepo = validated.repo;
  }
  if (!dir) {
    const rawRepo = values.repo ?? (deps.resolveLocalRepo ?? resolveRepoFromLocalGit)().repo;
    const repo = validateRepo(rawRepo);
    const id = validateMonitorId(
      selectedMonitorId(values, deps.env ?? process.env, deps.defaultMonitor ?? defaultMonitorId),
    );
    if (!repo.ok || !id.ok)
      return errorResult(
        'config',
        'missing --repo and could not derive owner/name from local git remotes',
        { at, command: 'watch' },
        values.format,
      );
    dir = watchDirPath(repo.repo, id.monitorId, values['state-dir'] ?? defaultStateDir());
  }
  try {
    const item = values.positionals?.[0];
    const result =
      action === 'add'
        ? addWatch(dir, item, values.until, {
            now,
            ...(scopedRepo ? { repo: scopedRepo } : {}),
            ...(action === 'add' ? { labels: labelsFromArgs(values.label) } : {}),
          })
        : action === 'rm'
          ? removeWatch(dir, item, scopedRepo ? { repo: scopedRepo } : {})
          : { entries: listWatch(dir) };
    return {
      code: 0,
      report: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: `watch ${action}`,
        watchDir: dir,
        at,
        ...(item ? { item } : {}),
        ...result,
        summary: action === 'ls' ? `${result.entries.length} watch item(s)` : `${action} complete`,
      },
      format: values.format,
    };
  } catch (err) {
    return errorResult(
      err.message?.includes('watch item') ||
        err.message?.includes('--until') ||
        err.message?.includes('invalid watch') ||
        err.message?.includes('duplicate') ||
        err.message?.includes('invalid label') ||
        err.message?.includes('duplicate label') ||
        err.message?.includes('labels must be') ||
        err.message?.includes('at most 8 labels')
        ? 'config'
        : 'io',
      String(err.message ?? err),
      { at, command: 'watch' },
      values.format,
    );
  }
}

export { runWatch };
