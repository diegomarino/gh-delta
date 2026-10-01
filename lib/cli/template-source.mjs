import { readFileSync as nodeReadFileSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { join } from 'node:path';
import { compileTemplate, loadTemplateFile } from '../template.mjs';

function readJson(path, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null };
    return { value: parsed };
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null };
    return { value: null };
  }
}

function flag(argv, name) {
  let value;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === `--${name}`) {
      if (seen) throw new Error(`--${name} must not be repeated`);
      seen = true;
      value = argv[i + 1];
      i += 1;
    } else if (token.startsWith(`--${name}=`)) {
      if (seen) throw new Error(`--${name} must not be repeated`);
      seen = true;
      value = token.slice(`--${name}=`.length);
    }
  }
  if (seen && (value === undefined || value === ''))
    throw new Error(`--${name} must not be empty or missing`);
  return seen ? value : undefined;
}

export function selectTemplateSource({ argv, env = {}, project, user }) {
  const layers = [
    { name: 'cli', template: flag(argv, 'template'), file: flag(argv, 'template-file') },
    { name: 'env', template: env.GH_DELTA_TEMPLATE, file: env.GH_DELTA_TEMPLATE_FILE },
    { name: 'project', template: project?.template, file: project?.['template-file'] },
    { name: 'user', template: user?.template, file: user?.['template-file'] },
  ];
  for (const layer of layers) {
    const hasText = layer.template !== undefined;
    const hasFile = layer.file !== undefined;
    if (!hasText && !hasFile) continue;
    if (hasText && hasFile) throw new Error('template and template-file are mutually exclusive');
    if ((hasText && layer.template === '') || (hasFile && layer.file === ''))
      throw new Error('template source must not be empty');
    if (hasText) return { template: layer.template, layer: layer.name };
    return { templateFile: layer.file, layer: layer.name };
  }
  return {};
}

export function resolveCompiledTemplate(values, argv, deps = {}) {
  const readFileSync = deps.readFileSync ?? nodeReadFileSync;
  const project = deps.ignoreConfigFiles
    ? { value: null }
    : readJson(join((deps.cwd ?? process.cwd)(), '.gh-delta.json'), readFileSync);
  const user = deps.ignoreConfigFiles
    ? { value: null }
    : readJson(
        join((deps.homedir ?? nodeHomedir)(), '.config', 'gh-delta', 'config.json'),
        readFileSync,
      );
  let source;
  try {
    source = selectTemplateSource({
      argv,
      env: deps.ignoreConfigFiles ? {} : (deps.env ?? process.env),
      project: project.value,
      user: user.value,
    });
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
  const sha = values['template-sha256'];
  if (sha !== undefined && !source.templateFile)
    return { error: '--template-sha256 requires --template-file' };
  if (values.format === 'template' && !source.template && !source.templateFile)
    return { error: '--format template requires --template or --template-file' };
  const hasSource = source.template || source.templateFile || sha !== undefined;
  if (values.format !== 'template' && hasSource) {
    if (source.layer && source.layer !== 'cli')
      return { error: `template source from ${source.layer} requires --format template` };
    return { error: '--template and --template-file require --format template' };
  }
  if (values.format !== 'template') return { compiled: null };
  try {
    if (source.template) return { compiled: compileTemplate(source.template) };
    const loaded = loadTemplateFile(source.templateFile, {
      cwd: (deps.cwd ?? process.cwd)(),
      expectedSha256: sha,
      readFileSync: deps.templateReadFileSync,
      lstatSync: deps.lstatSync,
      realpathSync: deps.realpathSync,
    });
    return { compiled: loaded.compiled };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}
