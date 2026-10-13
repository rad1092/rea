#!/usr/bin/env node
// Actual macOS boundary checks using only generated, owned fixtures. This does
// not run REA, substitute a mock for REA, or establish end-to-end analysis parity.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { NODE, cleanEnvironment, sandboxProfile } from '../lib/sandbox.mjs';

const integration = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(integration, '.runtime');
const lib = path.join(integration, 'lib');
const helper = path.join(lib, 'snapshot-worker.mjs');
const results = [];
const processes = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isDenied = code => code === 'EPERM' || code === 'EACCES';
let ownedRoot;
let fixturesRemoved = true;

function launch({ args, read, write = [], env, cwd, timeoutMs = 8000 }) {
  const child = spawn('/usr/bin/sandbox-exec', [
    '-p', sandboxProfile({ read, write }), NODE, ...args,
  ], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let stdout = '', stderr = '', outputBytes = 0, spawnError = null;
  let timedOut = false, exceededOutput = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 64 * 1024) { exceededOutput = true; child.kill('SIGKILL'); }
    else stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
  child.once('error', error => { spawnError = String(error.message); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(timer);
    processes.delete(child);
    resolve({ code, signal, stdout, stderr, spawnError, timedOut, exceededOutput });
  }));
  return { child, closed };
}

function requireSuccess(result) {
  assert.equal(result.spawnError, null, `Sandbox launcher failed: ${result.spawnError}`);
  assert.equal(result.timedOut, false, `Sandbox child timed out: ${result.stderr}`);
  assert.equal(result.exceededOutput, false, 'Sandbox child exceeded test output budget');
  assert.equal(result.code, 0, `Sandbox child failed (${result.code ?? result.signal}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function check(name, work) {
  const started = Date.now();
  try {
    const evidence = await work();
    results.push({ name, status: 'passed', duration_ms: Date.now() - started, evidence });
  } catch (error) {
    results.push({ name, status: 'failed', duration_ms: Date.now() - started, error: String(error.message) });
  }
}

async function waitFor(work, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await work();
    if (result) return result;
    await delay(25);
  }
  throw new Error('Owned fixture did not become ready before the test deadline');
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This script requires real macOS sandbox-exec; no fallback exists');
  process.umask(0o077);
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  ownedRoot = await fs.mkdtemp(path.join(runtime, 'sandbox-boundaries-owned-'));
  fixturesRemoved = false;
  ownedRoot = await fs.realpath(ownedRoot);
  const allowed = path.join(ownedRoot, 'allowed');
  const outside = path.join(ownedRoot, 'outside');
  await fs.mkdir(allowed, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  for (const directory of ['home', 'tmp']) await fs.mkdir(path.join(allowed, directory), { mode: 0o700 });
  const allowedFile = path.join(allowed, 'owned.txt');
  const outsideFile = path.join(outside, 'owned-outside.txt');
  await fs.writeFile(allowedFile, 'owned allowed fixture\n');
  await fs.writeFile(outsideFile, 'owned outside fixture\n');
  await fs.symlink(outsideFile, path.join(allowed, 'outside-link'));
  const sourceMap = path.join(allowed, 'owned.js.map');
  await fs.writeFile(sourceMap, JSON.stringify({ version: 3, sources: ['../outside/owned-outside.txt'], names: [], mappings: '' }));
  const env = cleanEnvironment(allowed);
  const runCode = async code => requireSuccess(await launch({
    args: ['--input-type=module', '-e', code], read: [allowed], write: [allowed], env, cwd: allowed,
  }).closed);

  await check('allowed-owned-file-readable', async () => {
    const result = await runCode(`import {readFileSync} from 'node:fs';console.log(JSON.stringify({text:readFileSync(${JSON.stringify(allowedFile)},'utf8')}));`);
    assert.equal(result.text, 'owned allowed fixture\n');
    return { readable: true };
  });

  for (const [name, filename] of [
    ['outside-owned-file-denied', outsideFile],
    ['symlink-outside-owned-root-denied', path.join(allowed, 'outside-link')],
  ]) await check(name, async () => {
    const result = await runCode(`import {readFileSync} from 'node:fs';let result;try{readFileSync(${JSON.stringify(filename)});result={readable:true};}catch(error){result={readable:false,code:error.code};}console.log(JSON.stringify(result));`);
    assert.equal(result.readable, false, 'Outside fixture was readable');
    assert.ok(isDenied(result.code), `Expected OS permission denial, received ${result.code}`);
    return result;
  });

  await check('outside-owned-file-write-denied', async () => {
    const result = await runCode(`import {writeFileSync} from 'node:fs';let result;try{writeFileSync(${JSON.stringify(outsideFile)},'attempted fixture overwrite');result={writable:true};}catch(error){result={writable:false,code:error.code};}console.log(JSON.stringify(result));`);
    assert.equal(result.writable, false, 'Outside fixture was writable');
    assert.ok(isDenied(result.code), `Expected OS permission denial, received ${result.code}`);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'owned outside fixture\n');
    return { ...result, outsideFixtureUnchanged: true };
  });

  await check('source-map-outside-reference-denied-at-filesystem-boundary', async () => {
    const result = await runCode(`import {readFileSync} from 'node:fs';import path from 'node:path';const filename=${JSON.stringify(sourceMap)};const map=JSON.parse(readFileSync(filename,'utf8'));const target=path.resolve(path.dirname(filename),map.sources[0]);let result;try{readFileSync(target);result={readable:true};}catch(error){result={readable:false,code:error.code};}console.log(JSON.stringify(result));`);
    assert.equal(result.readable, false);
    assert.ok(isDenied(result.code), `Expected OS permission denial, received ${result.code}`);
    return { ...result, scope: 'Direct filesystem attempt using a generated map reference; not an upstream parser test' };
  });

  await check('loopback-network-bind-denied', async () => {
    const result = await runCode(`import net from 'node:net';const server=net.createServer();const result=await new Promise(resolve=>{server.once('error',error=>resolve({bound:false,code:error.code}));server.listen({host:'127.0.0.1',port:0},()=>server.close(()=>resolve({bound:true})));});console.log(JSON.stringify(result));`);
    assert.equal(result.bound, false, 'Sandbox unexpectedly bound a loopback socket');
    assert.ok(isDenied(result.code), `Expected OS permission denial, received ${result.code}`);
    return result;
  });

  await check('loopback-network-connect-denied', async () => {
    // An ephemeral, loopback-only listener provides a working control. It is
    // closed before the next check; no external address or service is used.
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
      const port = server.address().port;
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('error', reject);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Owned loopback control timed out')); });
      });
      const result = await runCode(`import net from 'node:net';const socket=net.connect({host:'127.0.0.1',port:${port}});const result=await new Promise(resolve=>{socket.once('error',error=>resolve({connected:false,code:error.code}));socket.once('connect',()=>{socket.destroy();resolve({connected:true});});socket.setTimeout(1500,()=>{socket.destroy();resolve({connected:false,code:'TEST_TIMEOUT'});});});console.log(JSON.stringify(result));`);
      assert.equal(result.connected, false, 'Sandbox unexpectedly connected a loopback socket');
      assert.ok(isDenied(result.code), `Expected EPERM/EACCES, not a connectivity failure such as ${result.code}`);
      return { ...result, outsideSandboxControlConnected: true };
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  for (const detached of [false, true]) await check(`node-child-process-spawn-${detached ? 'detached-' : ''}denied`, async () => {
    const result = await runCode(`import {spawn} from 'node:child_process';let child;const result=await new Promise(resolve=>{try{child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',detached:${detached}});child.once('error',error=>resolve({spawned:false,code:error.code}));child.once('spawn',()=>{child.kill('SIGKILL');resolve({spawned:true});});}catch(error){resolve({spawned:false,code:error.code});}});console.log(JSON.stringify(result));`);
    assert.equal(result.spawned, false, 'Sandbox unexpectedly created another Node process');
    assert.ok(isDenied(result.code), `Expected OS permission denial, received ${result.code}`);
    return result;
  });

  await check('node-own-process-and-runtime-information-available', async () => {
    const result = await runCode(`import os from 'node:os';console.log(JSON.stringify({positiveOwnPid:process.pid>0,positiveRss:process.memoryUsage().rss>0,parallelismAvailable:os.availableParallelism()>0,totalMemoryAvailable:os.totalmem()>0,releaseAvailable:os.release().length>0}));`);
    assert.ok(Object.values(result).every(value => value === true));
    return { ...result, scope: 'Own-process/basic runtime functions only; not a proof of kern.proc denial' };
  });

  await check('ambient-sentinel-absent-and-private-home-temp', async () => {
    const key = 'REA_BOUNDARY_OWNED_TEST_SENTINEL';
    const old = process.env[key];
    process.env[key] = 'generated-test-value-not-a-credential';
    try {
      const isolatedEnv = cleanEnvironment(allowed);
      assert.equal(Object.hasOwn(isolatedEnv, key), false);
      const result = requireSuccess(await launch({
        args: ['--input-type=module', '-e', `console.log(JSON.stringify({sentinelPresent:Object.hasOwn(process.env,${JSON.stringify(key)}),nodeOptionsPresent:Object.hasOwn(process.env,'NODE_OPTIONS'),home:process.env.HOME,temp:process.env.TMPDIR}));`],
        read: [allowed], write: [allowed], env: isolatedEnv, cwd: allowed,
      }).closed);
      assert.equal(result.sentinelPresent, false);
      assert.equal(result.nodeOptionsPresent, false);
      assert.equal(result.home, path.join(allowed, 'home'));
      assert.equal(result.temp, path.join(allowed, 'tmp'));
      return { sentinelPresent: false, nodeOptionsPresent: false, dedicatedHome: true, dedicatedTemp: true };
    } finally {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  });

  await check('worker-thread-runs-within-parent-process', async () => {
    const workerCode = `const {parentPort,threadId}=require('node:worker_threads');parentPort.postMessage({pid:process.pid,threadId,value:21*2});`;
    const result = await runCode(`import {Worker} from 'node:worker_threads';const worker=new Worker(${JSON.stringify(workerCode)},{eval:true,execArgv:[]});const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await worker.terminate();console.log(JSON.stringify({parentPid:process.pid,...result}));`);
    assert.equal(result.pid, result.parentPid);
    assert.ok(result.threadId > 0);
    assert.equal(result.value, 42);
    return { sameProcess: true, threadId: result.threadId, value: result.value };
  });

  await check('parent-sigkill-ends-owned-worker-thread', async () => {
    const heartbeat = path.join(allowed, 'thread-heartbeat');
    const workerCode = `const {writeFileSync}=require('node:fs');let count=0;const tick=()=>writeFileSync(${JSON.stringify(heartbeat)},String(++count));tick();setInterval(tick,20);`;
    const running = launch({
      args: ['--input-type=module', '-e', `import {Worker} from 'node:worker_threads';const worker=new Worker(${JSON.stringify(workerCode)},{eval:true,execArgv:[]});worker.once('error',error=>{console.error(error.message);process.exit(1);});`],
      read: [allowed], write: [allowed], env, cwd: allowed,
    });
    try {
      const initialCount = await waitFor(async () => {
        try { const n = Number(await fs.readFile(heartbeat, 'utf8')); return n >= 2 && n; }
        catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
      });
      assert.equal(running.child.kill('SIGKILL'), true);
      const exit = await running.closed;
      assert.equal(exit.signal, 'SIGKILL');
      assert.equal(exit.timedOut, false);
      const before = await fs.readFile(heartbeat, 'utf8');
      await delay(250);
      const after = await fs.readFile(heartbeat, 'utf8');
      assert.equal(after, before, 'Owned worker heartbeat continued after its parent exited');
      return { initialCount, finalCount: Number(after), signal: exit.signal, stableAfterExitMs: 250 };
    } finally {
      running.child.kill('SIGKILL');
      await running.closed;
    }
  });

  async function snapshotCase(name, populate, expectedError) {
    await check(name, async () => {
      const source = path.join(ownedRoot, name + '-source');
      const destination = path.join(ownedRoot, name + '-destination');
      await fs.mkdir(source, { mode: 0o700 });
      await fs.mkdir(destination, { mode: 0o700 });
      await populate(source);
      const result = await launch({
        args: [helper, source, destination], read: [source, lib], write: [destination], env, cwd: ownedRoot,
      }).closed;
      assert.equal(result.spawnError, null);
      assert.equal(result.timedOut, false, `Snapshot test timed out: ${result.stderr}`);
      assert.equal(result.exceededOutput, false);
      if (expectedError) {
        assert.equal(result.code, 1, `Expected helper rejection, received ${result.code ?? result.signal}: ${result.stderr}`);
        assert.match(result.stderr, expectedError);
        return { rejected: true, reason: result.stderr };
      }
      const manifest = requireSuccess(result);
      assert.equal(manifest.files.length, 1);
      assert.equal(manifest.bytes, 16);
      assert.equal(manifest.files[0].path, 'index.js');
      assert.equal(manifest.files[0].sha256, createHash('sha256').update('export default 1').digest('hex'));
      assert.equal(await fs.readFile(path.join(destination, 'index.js'), 'utf8'), 'export default 1');
      return { copiedFiles: manifest.files.length, copiedBytes: manifest.bytes, hashVerified: true };
    });
  }

  await snapshotCase('snapshot-owned-regular-file-succeeds', source => fs.writeFile(path.join(source, 'index.js'), 'export default 1'));
  await snapshotCase('snapshot-symlink-rejected', source => fs.symlink(outsideFile, path.join(source, 'link.js')), /Symlinks are not accepted/);
  await snapshotCase('snapshot-inward-symlink-rejected', async source => {
    await fs.writeFile(path.join(source, 'owned.js'), 'owned');
    await fs.symlink('owned.js', path.join(source, 'link.js'));
  }, /Symlinks are not accepted/);
  await snapshotCase('snapshot-hardlink-rejected', async source => {
    const file = path.join(source, 'a.js');
    await fs.writeFile(file, 'owned');
    await fs.link(file, path.join(source, 'b.js'));
  }, /Only regular files with one link are accepted/);
  await snapshotCase('snapshot-oversized-file-rejected', source => fs.writeFile(path.join(source, 'large.js'), Buffer.alloc(512 * 1024 + 1, 120)), /Snapshot file\/byte limit exceeded/);
  await snapshotCase('snapshot-depth-13-rejected', async source => {
    let dir = source;
    for (let i = 0; i < 13; i++) { dir = path.join(dir, 'd'); await fs.mkdir(dir); }
  }, /Snapshot directory depth exceeds 12/);
  await snapshotCase('snapshot-129-total-directories-rejected', async source => {
    // The source root itself counts as one directory; each parent remains
    // below the unrelated per-directory entry limit.
    for (let i = 0; i < 128; i++) await fs.mkdir(path.join(source, `d${i}`));
  }, /Snapshot directory count exceeds 128/);
  await snapshotCase('snapshot-129-regular-files-rejected', async source => {
    for (let i = 0; i < 129; i++) await fs.writeFile(path.join(source, `f${i}.js`), 'x');
  }, /Snapshot file\/byte limit exceeded/);
  await snapshotCase('snapshot-over-8MiB-total-rejected', async source => {
    const block = Buffer.alloc(512 * 1024, 120);
    for (let i = 0; i < 17; i++) await fs.writeFile(path.join(source, `f${i}.js`), block);
  }, /Snapshot file\/byte limit exceeded/);
}

try { await main(); }
catch (error) { results.push({ name: 'harness-setup', status: 'failed', error: String(error.message) }); }
finally {
  for (const child of processes) child.kill('SIGKILL');
  // Each owned process has a bounded launcher timeout. Await its close before
  // deleting paths a worker could still use; do not inspect ambient processes.
  await Promise.all([...processes].map(child => new Promise(resolve => child.once('close', resolve))));
  if (ownedRoot) {
    try {
      await fs.rm(ownedRoot, { recursive: true, force: true });
      try {
        await fs.lstat(ownedRoot);
        throw new Error('Owned fixture root still exists after cleanup');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fixturesRemoved = true;
      }
    }
    catch (error) { results.push({ name: 'owned-fixture-cleanup', status: 'failed', error: String(error.message) }); }
  }
}
const failures = results.filter(result => result.status === 'failed').length;
process.stdout.write(JSON.stringify({
  generated_at: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  scope: 'Real sandbox boundaries and snapshot helper with generated owned fixtures only; no upstream analysis/model/integration claim',
  passed: results.length - failures,
  failed: failures,
  fixtures_removed: fixturesRemoved,
  results,
}, null, 2) + '\n');
process.exitCode = failures ? 1 : 0;
