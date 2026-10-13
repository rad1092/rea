#!/usr/bin/env node
// Real gateway + attested REA runtime only. Generated target JavaScript is
// analyzed as bytes and is never imported/executed. No model or mock server.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { UpstreamClient } from '../lib/upstream-client.mjs';
import { ALLOWED_TOOLS } from '../lib/contracts.mjs';

const integration = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// A vendored public copy must use scratch space outside its attested runtime.
const runtimeDir = path.resolve(process.env.REA_TEST_OUTPUT_DIR ?? path.join(integration, '.runtime'));
const gateway = path.join(integration, 'bin', 'rea-static-mcp.mjs');
const upstreamRoot = path.resolve(process.env.REA_TEST_RUNTIME ?? path.join(integration, '..', 'rea-static-source'));
const runtimeManifest = path.resolve(process.env.REA_TEST_MANIFEST ?? path.join(runtimeDir, 'thread-runtime-attestation.json'));
const reportPath = path.join(runtimeDir, 'real-mcp-e2e.json');
const report = { generated_at: new Date().toISOString(), node: process.version,
  scope: 'Actual MCP gateway and attested REA analysis of generated owned fixtures; no mock upstream or model calls',
  runtime: upstreamRoot, manifest: runtimeManifest, checks: [], rpc: [], retained: [], cleanup: [] };
const clients = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => createHash('sha256').update(text).digest('hex');
const evidenceRef = evidence_id => ({ kind: 'retained-evidence', evidence_id });
let fixtureRoot, analysisRoot, stateRun;

function textJson(result) {
  assert.ok(Array.isArray(result?.content), 'MCP tool result has no content array');
  const texts = result.content.filter(item => item.type === 'text');
  assert.equal(texts.length, 1, 'Expected one wrapper JSON text block');
  return JSON.parse(texts[0].text);
}
function success(result) {
  assert.notEqual(result?.isError, true, `Tool failed: ${JSON.stringify(result).slice(0, 1200)}`);
  return textJson(result);
}
function denied(result, pattern) {
  assert.equal(result?.isError, true, 'Call unexpectedly succeeded');
  const body = textJson(result);
  assert.match(JSON.stringify(body), pattern);
  return body;
}
async function check(name, work) {
  const started = Date.now();
  try {
    const evidence = await work();
    report.checks.push({ name, status: 'passed', duration_ms: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    report.checks.push({ name, status: 'failed', duration_ms: Date.now() - started, error: String(error.message) });
    throw error;
  }
}
async function environment(name) {
  const state = path.join(stateRun, name);
  await fs.mkdir(state, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: state, TMPDIR: state,
    REA_ANALYSIS_ROOT: analysisRoot, REA_UPSTREAM_ROOT: upstreamRoot,
    REA_STATE_ROOT: state, REA_RUNTIME_MANIFEST: runtimeManifest };
  return { env, state };
}
async function normalGateway(name) {
  const { env, state } = await environment(name);
  const client = new UpstreamClient({ command: process.execPath, args: [gateway], env, cwd: integration });
  let nextId = 0;
  const driver = {
    name, state,
    async rpc(method, params = {}, timeoutMs = 30000) {
      const id = ++nextId;
      const result = await client.request(method, params, timeoutMs);
      const responseBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result }));
      report.rpc.push({ session: name, id, method, params, result, response_json_bytes: responseBytes });
      assert.ok(responseBytes <= 16384, `Gateway response JSON exceeded 16 KiB: ${responseBytes}`);
      return result;
    },
    notify: (method, params) => client.notify(method, params),
    async shutdown() {
      const exit = await client.shutdown();
      clients.delete(driver);
      report.cleanup.push({ session: name, exit });
      return exit;
    },
  };
  clients.add(driver);
  return driver;
}
async function initialize(driver) {
  const result = await driver.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'rea-owned-e2e', version: '1' } }, 45000);
  assert.equal(result.serverInfo?.name, 'rea-static-gateway');
  driver.notify('notifications/initialized', {});
  return result;
}
const tool = (driver, name, args) => driver.rpc('tools/call', { name, arguments: args });
const call = (driver, name, args) => tool(driver, 'rea_call', { tool: name, arguments: args });

async function retained(driver, result, expectedTool, { forcePaged = false } = {}) {
  const receipt = success(result);
  assert.match(receipt.result_id, /^[a-f0-9-]{36}$/);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.upstream_tool, expectedTool);
  assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
  if (forcePaged) assert.equal(receipt.complete_inline, false, 'Expected an actual large retained result');
  const pages = [];
  let text;
  if (receipt.complete_inline) text = JSON.stringify(receipt.result);
  else {
    let offset = 0;
    const pieces = [];
    for (let count = 0; count < 4096; count++) {
      const page = success(await tool(driver, 'rea_read_result', { result_id: receipt.result_id, offset, limit: 6000 }));
      assert.equal(page.result_id, receipt.result_id);
      assert.equal(page.offset, offset);
      assert.ok(typeof page.text === 'string' && page.text.length <= 6000);
      assert.equal(page.next_offset, offset + page.text.length);
      assert.ok(page.next_offset <= page.total_chars);
      assert.ok(page.complete || page.next_offset > offset, 'Result cursor did not advance');
      pieces.push(page.text);
      pages.push({ offset, next_offset: page.next_offset, total_chars: page.total_chars, complete: page.complete });
      offset = page.next_offset;
      if (page.complete) { assert.equal(offset, page.total_chars); break; }
      assert.ok(count < 4095, 'Result paging exceeded test budget');
    }
    text = pieces.join('');
  }
  assert.equal(Buffer.byteLength(text), receipt.bytes, 'Retained response bytes changed during paging');
  assert.equal(digest(text), receipt.sha256, 'Retained response digest changed during paging');
  const full = JSON.parse(text);
  assert.equal(full.isError, false);
  assert.equal(full.tool, expectedTool);
  assert.ok(full.data && typeof full.data === 'object');
  if(!receipt.complete_inline) {
    if(receipt.projection) {
      assert.ok(Buffer.byteLength(JSON.stringify(receipt.projection))<=6000, 'Summary projection exceeded its 6000-byte budget');
      const selected = {
        summary:full.data.normalized_result?.summary, coverage:full.data.normalized_result?.coverage,
        authority:full.data.authority, confidence:full.data.confidence,
        source_evidence_id:full.data.normalized_result?.source_evidence_id, trace_id:full.data.normalized_result?.trace_id,
      };
      for(const [key,value] of Object.entries(selected)) assert.deepEqual(receipt.projection[key],value, `Projection changed ${key}`);
      if(receipt.projection.limitations_omitted) {
        assert.equal(Object.hasOwn(receipt.projection,'limitations'),false);
        assert.equal(receipt.projection.omitted_limitations_count,full.data.normalized_result.limitations.length);
      } else assert.deepEqual(receipt.projection.limitations,full.data.normalized_result?.limitations);
    } else {
      assert.equal(receipt.projection_omitted,true);
      assert.ok(typeof receipt.projection_omission_reason==='string' && receipt.projection_omission_reason.length>0);
    }
  }
  const item = { session: driver.name, receipt, pages, full };
  report.retained.push(item);
  return item;
}
const normalized = item => item.full.data.normalized_result;
async function analyze(driver, relativePath) {
  const item = await retained(driver, await tool(driver, 'rea_analyze', { input_path: relativePath }), 'analyze_javascript_application');
  const data = normalized(item);
  assert.equal(data.kind, 'summary');
  assert.equal(data.parent_operation, 'analyze_javascript_application');
  assert.match(data.parent_evidence_id, /^ev_[a-f0-9]{64}$/);
  assert.equal(data.summary.format, 'directory');
  assert.equal(data.summary.statistics.parsed_javascript_files, 1);
  assert.equal(data.summary.statistics.parse_failures, 0);
  assert.match(data.summary.root_artifact_sha256, /^[a-f0-9]{64}$/);
  return { item, parent: data.parent_evidence_id, hash: data.summary.root_artifact_sha256 };
}

// A raw client is used only for deliberately invalid JSON-RPC IDs and an exact
// cancellation request ID; it still launches the same real gateway/runtime.
async function rawGateway(name) {
  const { env, state } = await environment(name);
  const child = spawn(process.execPath, [gateway], { env, cwd: integration, stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [], waiting = [];
  let buffer = Buffer.alloc(0), stderr = '', failure, closed = false;
  const rejectWaiting = error => { failure = error; for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } };
  child.stdin.on('error', rejectWaiting);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.once('error', rejectWaiting);
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 128 * 1024) { rejectWaiting(new Error('Raw gateway exceeded receive budget')); child.stdin.end(); return; }
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      if (!line.length) continue;
      try {
        assert.ok(line.length <= 16384, `Actual raw response JSON exceeded 16 KiB: ${line.length}`);
        const packet = { message: JSON.parse(line.toString('utf8')), response_json_bytes: line.length };
        const waiter = waiting.shift();
        if (waiter) { clearTimeout(waiter.timer); waiter.resolve(packet); } else queue.push(packet);
      } catch (error) { rejectWaiting(error); child.stdin.end(); }
    }
  });
  const exitPromise = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; rejectWaiting(new Error(`Raw gateway exited (${code ?? signal}): ${stderr}`)); resolve({ code, signal });
  }));
  const driver = {
    name, state, queue,
    send(message) { if (failure) throw failure; child.stdin.write(JSON.stringify(message) + '\n'); },
    next(timeoutMs = 30000) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiter.timer = setTimeout(() => { waiting.splice(waiting.indexOf(waiter), 1); reject(new Error('Raw gateway response deadline exceeded')); }, timeoutMs);
        waiting.push(waiter);
      });
    },
    async exchange(message, expectedId = message.id) {
      driver.send(message);
      const packet = await driver.next(message.method === 'initialize' ? 45000 : 30000);
      report.rpc.push({ session: name, request: message, response: packet.message, response_json_bytes: packet.response_json_bytes });
      assert.deepEqual(packet.message.id, expectedId);
      return packet.message;
    },
    async shutdown() {
      if (!closed) child.stdin.end();
      const term = setTimeout(() => child.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { const exit = await exitPromise; clients.delete(driver); report.cleanup.push({ session: name, exit }); return exit; }
      finally { clearTimeout(term); clearTimeout(kill); }
    },
  };
  clients.add(driver);
  return driver;
}

async function main() {
  process.umask(0o077);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const stateParent = path.join(runtimeDir, 'e2e-state');
  await fs.mkdir(stateParent, { recursive: true, mode: 0o700 });
  stateRun = await fs.mkdtemp(path.join(stateParent, 'run-'));
  fixtureRoot = await fs.mkdtemp(path.join(runtimeDir, 'e2e-owned-'));
  analysisRoot = path.join(fixtureRoot, 'inputs');
  await fs.mkdir(analysisRoot, { mode: 0o700 });
  await fs.access(runtimeManifest);
  const largeA = 'A'.repeat(24000), largeB = 'B'.repeat(24000);
  for (const [name, version, factor, extra, payload] of [
    ['app-v1', '1.0.0', 7, '', largeA], ['app-v2', '2.0.0', 9, ', taxable: true', largeB],
  ]) {
    const directory = path.join(analysisRoot, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'rea-owned-e2e-fixture', version, type: 'module', main: 'index.js' }));
    // Route properties become static endpoint candidates; bound object values
    // become semantic literal nodes. Arbitrary condition/return literals alone
    // are not guaranteed to exist in either graph.
    await fs.writeFile(path.join(directory, 'index.js'), `// Owned static-analysis fixture; never execute.\nexport const fixtureMetadata={path:'/quote',currency:'USD'};\nexport function quote(quantity){return {total:quantity*${factor},currency:'USD'${extra}};}\nexport function route(request){if(request.path==='/quote')return quote(request.quantity);return {error:'not-found'};}\nexport function paginationProbe(){return {kind:'pagination-probe',payload:${JSON.stringify(payload)}};}\n`);
  }
  await fs.mkdir(path.join(fixtureRoot, 'outside'));
  await fs.writeFile(path.join(fixtureRoot, 'outside', 'owned.txt'), 'owned outside fixture');
  await fs.symlink(path.join(fixtureRoot, 'outside'), path.join(analysisRoot, 'outside-link'));
  const stress = path.join(analysisRoot, 'stress');
  await fs.mkdir(stress);
  for (let file = 0; file < 8; file++) {
    const source = Array.from({ length: 3000 }, (_, i) => `export function f${i}(x){return {kind:'owned-${file}-${i}',value:x+${i}};}\n`).join('');
    assert.ok(Buffer.byteLength(source) <= 512 * 1024);
    await fs.writeFile(path.join(stress, `part-${file}.js`), source);
  }

  const first = await normalGateway('analysis');
  await check('actual-mcp-initialize-list-four-and-discover-six', async () => {
    await initialize(first);
    const inventory = await first.rpc('tools/list');
    assert.deepEqual(inventory.tools.map(item => item.name), ['rea_analyze', 'rea_discover', 'rea_call', 'rea_read_result']);
    const catalog = success(await tool(first, 'rea_discover', {}));
    assert.deepEqual(catalog.operations.map(item => item.name), ALLOWED_TOOLS);
    for (const name of ALLOWED_TOOLS) assert.ok(success(await tool(first, 'rea_discover', { tool: name })).inputSchema);
    return { publicTools: 4, staticOperations: 6 };
  });
  await check('actual-dispatch-denies-forbidden-path-and-inline-inputs', async () => {
    const cases = [
      ['inspect_artifact', { input_path: analysisRoot }, /not allowed/i],
      ['rea_call', { tool: 'inspect_artifact', arguments: {} }, /disallowed|allowed|unsupported/i],
      ['rea_call', { tool: 'analyze_javascript_application', arguments: { input_path: analysisRoot } }, /disallowed|allowed|unsupported/i],
      ['rea_analyze', { input_path: '../outside' }, /relative|escaped|traversal/i],
      ['rea_analyze', { input_path: 'outside-link' }, /symlink/i],
      ['rea_analyze', { input_path: 'app-v1', source_paths: ['../outside/owned.txt'] }, /relative|traversal/i],
      ['rea_call', { tool: 'inspect_analysis_view', arguments: { source: { kind: 'inline', evidence: {} }, view: { kind: 'summary' } } }, /disallowed|allowed|unsupported/i],
      ['rea_discover', { tool: null }, /disallowed|allowed/i],
    ];
    for (const [name, args, pattern] of cases) denied(await tool(first, name, args), pattern);
    return { deniedCases: cases.length };
  });

  const left = await check('actual-analysis-v1-retains-parent-evidence', () => analyze(first, 'app-v1'));
  await check('actual-module-page-and-exact-item', async () => {
    const page = await retained(first, await call(first, 'inspect_analysis_view', { source: evidenceRef(left.parent), view: { kind: 'page', collection: 'modules', offset: 0, limit: 20 } }), 'inspect_analysis_view');
    const data = normalized(page);
    assert.equal(data.kind, 'page'); assert.equal(data.parent_evidence_id, left.parent);
    const module = data.items.find(item => item.path === 'index.js');
    assert.ok(module, 'Analyzed source module missing from retained module page');
    const item = await retained(first, await call(first, 'inspect_analysis_view', { source: evidenceRef(left.parent), view: { kind: 'item', collection: 'modules', selector: { node_id: module.node_id } } }), 'inspect_analysis_view');
    assert.equal(normalized(item).item.node_id, module.node_id);
    return { path: module.path, node_id: module.node_id };
  });
  await check('actual-feature-trace-quote-route-metadata', async () => {
    const item = await retained(first, await call(first, 'trace_application_feature', { application: evidenceRef(left.parent), seed: { kind: 'route', value: '/quote', match: 'exact', case_sensitive: true }, direction: 'both' }), 'trace_application_feature');
    const data = normalized(item);
    assert.equal(data.source_evidence_id, left.parent);
    assert.ok(data.summary.matched_seeds > 0); assert.equal(data.seed_matches.length, data.summary.matched_seeds);
    assert.ok(data.seed_matches.some(seed => seed.kind === 'endpoint'));
    assert.ok(data.summary.traced_nodes > 0); assert.ok(data.graph);
    return { matchedSeeds: data.summary.matched_seeds, tracedNodes: data.summary.traced_nodes, coverage: data.coverage };
  });
  await check('actual-semantic-trace-currency-literal', async () => {
    const item = await retained(first, await call(first, 'trace_javascript_semantics', { application: evidenceRef(left.parent), query: { seed: { kind: 'literal', value: 'USD' }, direction: 'forward-influence' } }), 'trace_javascript_semantics');
    const data = normalized(item);
    assert.equal(data.source_evidence_id, left.parent);
    assert.ok(data.seed_node_ids.length > 0);
    assert.equal(data.summary.total_seed_matches, data.seed_node_ids.length);
    assert.ok(data.nodes.some(node => node.kind === 'literal' && node.properties.value === 'USD'));
    assert.equal(data.summary.traversed_nodes, data.nodes.length);
    return { status: data.status, seeds: data.seed_node_ids.length, nodes: data.nodes.length };
  });

  const right = await check('actual-analysis-v2-retains-distinct-parent', async () => {
    const result = await analyze(first, 'app-v2');
    assert.notEqual(result.parent, left.parent); assert.notEqual(result.hash, left.hash); return result;
  });
  await check('actual-application-version-comparison', async () => {
    const item = await retained(first, await call(first, 'compare_application_versions', { left: evidenceRef(left.parent), right: evidenceRef(right.parent) }), 'compare_application_versions');
    const data = normalized(item);
    assert.equal(data.left.evidence_id, left.parent); assert.equal(data.right.evidence_id, right.parent);
    assert.match(data.comparison_id, /^javc_[a-f0-9]{64}$/);
    assert.ok(data.items.some(row => ['added', 'removed', 'changed'].includes(row.status)));
    return { comparison_id: data.comparison_id, summary: data.summary, coverage: data.coverage };
  });
  const compareArgs = { left: evidenceRef(left.parent), right: evidenceRef(right.parent), left_module_path: 'index.js', right_module_path: 'index.js' };
  await check('actual-export-shape-comparison-detects-taxable', async () => {
    const item = await retained(first, await call(first, 'compare_javascript_export_shapes', { ...compareArgs, left_export_name: 'quote', right_export_name: 'quote' }), 'compare_javascript_export_shapes');
    const data = normalized(item);
    assert.equal(data.left.status, 'selected'); assert.equal(data.right.status, 'selected');
    assert.ok(data.changes.some(row => row.path === '/taxable' && row.status === 'added' && row.right.availability === 'literal' && row.right.value === true));
    return { summary: data.summary, addedTaxable: true };
  });
  const large = await check('actual-large-result-pages-roundtrip-and-bounds', async () => {
    const item = await retained(first, await call(first, 'compare_javascript_export_shapes', { ...compareArgs, left_export_name: 'paginationProbe', right_export_name: 'paginationProbe' }), 'compare_javascript_export_shapes', { forcePaged: true });
    const change = normalized(item).changes.find(row => row.path === '/payload' && row.status === 'changed');
    assert.ok(change); assert.equal(change.left.value, largeA); assert.equal(change.right.value, largeB);
    assert.ok(item.pages.length > 1);
    assert.ok(item.receipt.projection, 'Large comparison receipt must expose its bounded real summary');
    assert.deepEqual(item.receipt.projection.summary, normalized(item).summary);
    assert.deepEqual(item.receipt.projection.coverage, normalized(item).coverage);
    assert.equal(digest(JSON.stringify(item.full)),item.receipt.sha256,'Adding the projection changed retained evidence bytes');
    denied(await tool(first, 'rea_read_result', { result_id: item.receipt.result_id, limit: 6001 }), /allowed|range/i);
    denied(await tool(first, 'rea_read_result', { result_id: item.receipt.result_id, offset: 9007199254740991 }), /range/i);
    return { result_id: item.receipt.result_id, bytes: item.receipt.bytes, sha256: item.receipt.sha256, pages: item.pages.length,
      summaryProjection:true, projection_bytes:Buffer.byteLength(JSON.stringify(item.receipt.projection)) };
  });
  await check('first-gateway-graceful-shutdown', async () => { const exit = await first.shutdown(); assert.equal(exit.code, 0); return exit; });

  const second = await rawGateway('restart-cancel');
  await check('fresh-gateway-rejects-previous-session-evidence-and-result', async () => {
    const init = await second.exchange({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rea-e2e-raw', version: '1' } } });
    assert.equal(init.result.serverInfo.name, 'rea-static-gateway');
    second.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const evidence = await second.exchange({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rea_call', arguments: { tool: 'inspect_analysis_view', arguments: { source: evidenceRef(left.parent), view: { kind: 'summary' } } } } });
    denied(evidence.result, /not owned by this session/i);
    const result = await second.exchange({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rea_read_result', arguments: { result_id: large.result_id } } });
    denied(result.result, /not owned by this session/i);
    return { previousEvidenceRejected: true, previousResultRejected: true };
  });
  await check('actual-wire-rejects-oversized-and-object-ids', async () => {
    for (const id of ['x'.repeat(20000), { invalid: true }]) {
      const result = await second.exchange({ jsonrpc: '2.0', id, method: 'ping', params: {} }, null);
      assert.equal(result.error?.code, -32600);
    }
    const escapedId = '\0'.repeat(128);
    const good = await second.exchange({ jsonrpc: '2.0', id: escapedId, method: 'ping', params: {} });
    assert.deepEqual(good.result, {});
    return { largeIdRejected: true, objectIdRejected: true, worstEscapedAcceptedIdWorked: true };
  });
  await check('actual-stress-analysis-cancellation-invalidates-session', async () => {
    const sessions = (await fs.readdir(second.state)).filter(name => name.startsWith('rea-session-'));
    assert.equal(sessions.length, 1);
    const snapshotManifest = path.join(second.state, sessions[0], 'snapshot-1.json');
    const request = { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'rea_analyze', arguments: { input_path: 'stress' } } };
    second.send(request);
    const until = Date.now() + 6000;
    let snapshotReady = false;
    while (Date.now() < until) {
      try {
        const manifest = JSON.parse(await fs.readFile(snapshotManifest, 'utf8'));
        assert.equal(manifest.files.length, 8); assert.ok(manifest.bytes > 0);
        snapshotReady = true; break;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      assert.equal(second.queue.length, 0, 'Analysis finished before cancellation could be verified');
      await delay(5);
    }
    assert.ok(snapshotReady, 'Actual stress snapshot was not admitted before cancellation deadline');
    assert.equal(second.queue.length, 0, 'Analysis finished before cancellation could be verified');
    const started = Date.now();
    second.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100, reason: 'Owned e2e cancellation fixture' } });
    const packet = await second.next(10000);
    report.rpc.push({ session: second.name, request, response: packet.message, response_json_bytes: packet.response_json_bytes, cancelled: true });
    assert.equal(packet.message.id, 100);
    denied(packet.message.result, /cancelled|invalidated|aborted/i);
    const afterwards = await second.exchange({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'rea_discover', arguments: {} } });
    denied(afterwards.result, /invalidated/i);
    return { actualSnapshotCompleted: true, cancellation_ms: Date.now() - started, subsequentToolRejected: true,
      scope: 'In-flight gateway analysis cancelled after completed real snapshot; no assertion that the REA worker had started' };
  });
  await check('cancelled-gateway-graceful-shutdown', async () => { const exit = await second.shutdown(); assert.equal(exit.code, 0); return exit; });

  const third = await normalGateway('after-cancellation');
  await check('fresh-gateway-analyzes-successfully-after-cancellation', async () => {
    await initialize(third);
    const result = await analyze(third, 'app-v1');
    return { parent_evidence_id: result.parent, parsedJavascriptFiles: 1 };
  });
  await check('final-gateway-graceful-shutdown', async () => { const exit = await third.shutdown(); assert.equal(exit.code, 0); return exit; });
}

try { await main(); }
catch (error) { report.error = String(error.stack ?? error); }
finally {
  for (const client of [...clients]) {
    try { await client.shutdown(); } catch (error) { report.cleanup.push({ session: client.name, error: String(error.message) }); }
  }
  for (const directory of [fixtureRoot, stateRun].filter(Boolean)) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      try { await fs.lstat(directory); throw new Error('Owned directory remains after cleanup'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      report.cleanup.push({ ownedDirectory: directory, removed: true });
    } catch (error) { report.cleanup.push({ ownedDirectory: directory, removed: false, error: String(error.message) }); }
  }
  report.completed_at = new Date().toISOString();
  report.passed = report.checks.filter(item => item.status === 'passed').length;
  report.failed = report.checks.filter(item => item.status === 'failed').length;
  report.ok = !report.error && report.failed === 0 && report.cleanup.every(item => !item.error);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: report.ok, passed: report.passed, failed: report.failed, report: reportPath, error: report.error?.split('\n')[0] }) + '\n');
  process.exitCode = report.ok ? 0 : 1;
}
