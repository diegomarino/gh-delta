import { errorResult } from '../errors.mjs';
import { formatSniff, commandHelp, WATCH_OPTIONS } from '../parse.mjs';
import { parseArgs } from 'node:util';
import { validateRepo, validateMonitorId, defaultMonitorId } from '../../args.mjs';
import { resolveRepoFromLocalGit } from '../../repo-source.mjs';
import { selectedMonitorId } from '../config.mjs';
import { watchDirPath, addWatch, removeWatch, listWatch } from '../../watch.mjs';
import { defaultStateDir } from '../../snapshot.mjs';
import { REPORT_SCHEMA_VERSION } from '../../contract.mjs';

function runWatch(argv, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const action = argv.shift();
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
    const parsed = parseArgs({ args: argv, options: WATCH_OPTIONS, allowPositionals: true });
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
        ? addWatch(dir, item, values.until, { now, ...(scopedRepo ? { repo: scopedRepo } : {}) })
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
        err.message?.includes('duplicate')
        ? 'config'
        : 'io',
      String(err.message ?? err),
      { at, command: 'watch' },
      values.format,
    );
  }
}

export { runWatch };
