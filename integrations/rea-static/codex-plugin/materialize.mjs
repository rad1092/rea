#!/usr/bin/env node
import { cp, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Render a NEW local package. Never install it or alter Codex configuration.
const template = path.dirname(fileURLToPath(import.meta.url));
const names = ['node', 'integration-root', 'upstream-root', 'analysis-root', 'state-root', 'runtime-manifest', 'output'];
const options = Object.create(null);
try {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !names.includes(key) || !argv[i + 1] || options[key]) {
      throw new Error('Use each required --name ABSOLUTE_PATH option once.');
    }
    options[key] = argv[i + 1];
  }
  for (const key of names) {
    if (!options[key] || !path.isAbsolute(options[key]) || options[key].includes('\0')) {
      throw new Error(`--${key} must be an absolute path.`);
    }
  }
  const within = (root, value) => value === root || value.startsWith(root + path.sep);
  const paths = Object.create(null);
  for (const key of names.filter(key => key !== 'output')) {
    paths[key] = await realpath(options[key]);
    const stat = await lstat(paths[key]);
    if (['node', 'runtime-manifest'].includes(key) ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`--${key} is not the expected file or directory.`);
    }
  }
  if (paths['analysis-root'] === path.parse(paths['analysis-root']).root) {
    throw new Error('The filesystem root cannot be an analysis root.');
  }
  for (const key of ['integration-root', 'upstream-root', 'state-root']) {
    if (within(paths['analysis-root'], paths[key]) || within(paths[key], paths['analysis-root'])) {
      throw new Error(`The analysis root must be separate from --${key}.`);
    }
  }
  const wrapper = await realpath(path.join(paths['integration-root'], 'bin/rea-static-mcp.mjs'));
  if (!within(paths['integration-root'], wrapper) || !(await lstat(wrapper)).isFile()) {
    throw new Error('The fixed wrapper must be a file inside the integration root.');
  }
  const output = path.join(await realpath(path.dirname(options.output)), path.basename(options.output));
  try {
    await lstat(output);
    throw new Error('The output path already exists; no files were changed.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const root of [template, paths['analysis-root'], paths['upstream-root'], paths['state-root']]) {
    if (within(root, output) || within(output, root)) throw new Error('Output overlaps an input or state directory.');
  }
  const portable = JSON.parse(await readFile(path.join(template, 'mcp.json'), 'utf8'));
  portable.mcpServers['rea-static'] = {
    type: 'stdio',
    command: '/usr/bin/env',
    args: [
      '-i', 'PATH=/usr/bin:/bin',
      `REA_ANALYSIS_ROOT=${paths['analysis-root']}`,
      `REA_UPSTREAM_ROOT=${paths['upstream-root']}`,
      `REA_STATE_ROOT=${paths['state-root']}`,
      `REA_RUNTIME_MANIFEST=${paths['runtime-manifest']}`,
      paths.node, wrapper,
    ],
  };
  const { type: _type, ...legacyServer } = portable.mcpServers['rea-static'];
  await cp(template, output, { recursive: true, errorOnExist: true, force: false });
  await writeFile(path.join(output, 'mcp.json'), JSON.stringify(portable, null, 2) + '\n');
  await writeFile(path.join(output, '.mcp.json'), JSON.stringify({ mcpServers: { 'rea-static': legacyServer } }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, registered: false, analysisRoot: paths['analysis-root'] }) + '\n');
} catch (error) {
  process.stderr.write(`REA package preparation failed: ${error.message}\n`);
  process.exitCode = 1;
}
