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
    const analysis = path.join(root, "analysis = ' $(literal) `literal`");
    const state = path.join(root, 'state');
    const output = path.join(root, 'plugin');
    await Promise.all([mkdir(path.join(integration, 'bin'), { recursive: true }), mkdir(upstream), mkdir(analysis), mkdir(state)]);
    // This owned stub tests launcher semantics only. It does not validate REA.
    await writeFile(path.join(integration, 'bin/rea-static-mcp.mjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
    await writeFile(path.join(integration, 'runtime-manifest.json'), '{}');
    // The alias may contain '=' when the actual executable path does not.
    const nodeAlias = path.join(root, 'node=alias');
    await symlink(process.execPath, nodeAlias);
    const args = ['--node', nodeAlias, '--integration-root', integration, '--upstream-root', upstream,
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
    const child = spawnSync(path.join(output, server.command), server.args, { encoding: 'utf8', env: { ...process.env, REA_TEST_SECRET: 'must-not-forward', NODE_OPTIONS: '--definitely-invalid-for-this-test', BASH_ENV: startup, ENV: startup, SHELLOPTS: 'noexec:verbose:xtrace' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const received = JSON.parse(child.stdout);
    assert.equal(received.REA_TEST_SECRET, undefined);
    assert.equal(received.NODE_OPTIONS, undefined);
    assert.equal(received.PATH, '/usr/bin:/bin');
    assert.equal(path.basename(received.REA_ANALYSIS_ROOT), "analysis = ' $(literal) `literal`");
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

test('rejects equals in the canonical Node path before creating a package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-package-'));
  try {
    await Promise.all(['integration/bin', 'upstream', 'analysis', 'state'].map(dir => mkdir(path.join(root, dir), { recursive: true })));
    await writeFile(path.join(root, 'integration/bin/rea-static-mcp.mjs'), '');
    await writeFile(path.join(root, 'manifest.json'), '{}');
    // An owned file is enough to test path validation; it is never executed.
    const unsafeNode = path.join(root, 'node=owned-fixture');
    const nodeAlias = path.join(root, 'node-alias');
    await writeFile(unsafeNode, '#!/bin/sh\nexit 0\n');
    await symlink(unsafeNode, nodeAlias);
    for (const [index, node] of [unsafeNode, nodeAlias].entries()) {
      const output = path.join(root, `plugin-${index}`);
      const result = run('--node', node, '--integration-root', path.join(root, 'integration'),
        '--upstream-root', path.join(root, 'upstream'), '--analysis-root', path.join(root, 'analysis'),
        '--state-root', path.join(root, 'state'), '--runtime-manifest', path.join(root, 'manifest.json'), '--output', output);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /canonical --node path must not contain '='/);
      assert.equal(result.stdout, '');
      await assert.rejects(access(output), { code: 'ENOENT' });
    }
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
