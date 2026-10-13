import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../materialize.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('refuses incomplete input without producing a package', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be an absolute path/);
});

test('materializes explicit paths and launcher drops unrelated environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-package-'));
  try {
    const integration = path.join(root, 'integration');
    const upstream = path.join(root, 'upstream');
    const analysis = path.join(root, "analysis ' $(literal) `literal`");
    const state = path.join(root, 'state');
    const output = path.join(root, 'plugin');
    await Promise.all([mkdir(path.join(integration, 'bin'), { recursive: true }), mkdir(upstream), mkdir(analysis), mkdir(state)]);
    // This owned stub tests launcher semantics only. It does not validate REA.
    await writeFile(path.join(integration, 'bin/rea-static-mcp.mjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
    await writeFile(path.join(integration, 'runtime-manifest.json'), '{}');
    const args = ['--node', process.execPath, '--integration-root', integration, '--upstream-root', upstream,
      '--analysis-root', analysis, '--state-root', state,
      '--runtime-manifest', path.join(integration, 'runtime-manifest.json'), '--output', output];
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).registered, false);
    const portable = JSON.parse(await readFile(path.join(output, 'mcp.json')));
    const legacy = JSON.parse(await readFile(path.join(output, '.mcp.json')));
    const { type, ...server } = portable.mcpServers['rea-static'];
    assert.equal(type, 'stdio');
    assert.equal(server.command, './scripts/launch-rea.sh');
    assert.deepEqual(server.args, []);
    assert.deepEqual(server, legacy.mcpServers['rea-static']);
    const startup = path.join(root, 'untrusted-shell-startup');
    const marker = path.join(root, 'must-not-exist');
    await writeFile(startup, `touch '${marker}'\n`);
    const child = spawnSync(path.join(output, server.command), server.args, { encoding: 'utf8', env: { ...process.env, REA_TEST_SECRET: 'must-not-forward', NODE_OPTIONS: '--definitely-invalid-for-this-test', BASH_ENV: startup, ENV: startup } });
    assert.equal(child.status, 0, child.stderr);
    const received = JSON.parse(child.stdout);
    assert.equal(received.REA_TEST_SECRET, undefined);
    assert.equal(received.NODE_OPTIONS, undefined);
    assert.equal(received.PATH, '/usr/bin:/bin');
    assert.equal(path.basename(received.REA_ANALYSIS_ROOT), "analysis ' $(literal) `literal`");
    await assert.rejects(access(marker));
    // macOS may inject this locale bookkeeping variable after env -i.
    if (process.platform === 'darwin') delete received.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(Object.keys(received).sort(), ['PATH', 'REA_ANALYSIS_ROOT', 'REA_RUNTIME_MANIFEST', 'REA_STATE_ROOT', 'REA_UPSTREAM_ROOT']);
    const before = await readFile(path.join(output, 'mcp.json'), 'utf8');
    const repeat = run(...args);
    assert.equal(repeat.status, 1);
    assert.match(repeat.stderr, /already exists/);
    assert.equal(await readFile(path.join(output, 'mcp.json'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a wrapper symlink outside the integration root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-package-'));
  try {
    await Promise.all(['integration/bin', 'upstream', 'analysis', 'state'].map(dir => mkdir(path.join(root, dir), { recursive: true })));
    await writeFile(path.join(root, 'outside.mjs'), '');
    await writeFile(path.join(root, 'manifest.json'), '{}');
    await symlink(path.join(root, 'outside.mjs'), path.join(root, 'integration/bin/rea-static-mcp.mjs'));
    const result = run('--node', process.execPath, '--integration-root', path.join(root, 'integration'),
      '--upstream-root', path.join(root, 'upstream'), '--analysis-root', path.join(root, 'analysis'),
      '--state-root', path.join(root, 'state'), '--runtime-manifest', path.join(root, 'manifest.json'), '--output', path.join(root, 'plugin'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixed wrapper must be a file inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
