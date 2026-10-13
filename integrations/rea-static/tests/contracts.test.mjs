import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, publicTools, getSchema, validateCall, validatePublicCall } from '../lib/contracts.mjs';

const leftId = `ev_${'a'.repeat(64)}`;
const rightId = `ev_${'b'.repeat(64)}`;
const left = { kind: 'retained-evidence', evidence_id: leftId };
const right = { kind: 'retained-evidence', evidence_id: rightId };
const owned = new Set([leftId, rightId]);
const call = (name, input, evidence = owned) => validateCall(name, input, evidence);

test('public catalog stays compact and separates acquisition from derived calls', () => {
  assert.equal(ALLOWED_TOOLS.length, 6);
  assert.deepEqual(publicTools.map(tool => tool.name), ['rea_analyze', 'rea_discover', 'rea_call', 'rea_read_result']);
  assert.equal(publicTools[2].inputSchema.properties.tool.enum.includes('analyze_javascript_application'), false);
  assert.ok(JSON.stringify(publicTools).length < 6000);
  assert.throws(() => getSchema('inspect_artifact'), /not allowed/);
  assert.throws(() => call('__proto__', {}), /not allowed/);
});

test('analysis fixes the profile and rejects hostile or oversized controls', () => {
  assert.deepEqual(call('analyze_javascript_application', { input_path: '/staged/app' }), {
    input_path: '/staged/app', format: 'directory', detail: 'summary', integrity_policy: 'fail',
    max_semantic_nodes: 5000, max_semantic_nodes_per_file: 1000, max_heap_mb: 256, analysis_timeout_ms: 5000,
  });
  for (const override of [
    { format: 'asar' }, { integrity_policy: 'record-and-continue' }, { detail: 'complete' },
    { max_heap_mb: 257 }, { max_semantic_nodes: 5001 }, { analysis_timeout_ms: 5001 },
    { command: '/bin/sh' }, { input_path: '/staged/app\0bad' },
  ]) assert.throws(() => call('analyze_javascript_application', { input_path: '/staged/app', ...override }), TypeError);
  for (const path of ['../secret.js', '/secret.js', 'a/../secret.js', 'a//b.js', './app.js', 'a\\b.js']) {
    assert.throws(() => call('analyze_javascript_application', { input_path: '/staged/app', source_paths: [path] }), /relative inventory paths/);
  }
  assert.throws(() => call('analyze_javascript_application', { input_path: '/staged/app', source_paths: ['a.js', 'a.js'] }), /unique/);
});

test('retained views enforce owner, narrow facets and response row limit', () => {
  const base = { source: left, view: { kind: 'page', collection: 'modules' } };
  assert.deepEqual(call('inspect_analysis_view', base).view, { kind: 'page', collection: 'modules', offset: 0, limit: 10 });
  assert.throws(() => call('inspect_analysis_view', base, new Set()), /not owned/);
  for (const view of [
    { kind: 'page', collection: 'modules', offset: 0, limit: 21 },
    { kind: 'page', collection: 'modules', offset: -1, limit: 1 },
    { kind: 'page', collection: 'modules', offset: 0.5, limit: 1 },
    { kind: 'native', facet: 'pseudocode' }, { kind: 'summary', evidence: {} },
  ]) assert.throws(() => call('inspect_analysis_view', { source: left, view }), TypeError);
  assert.throws(() => call('inspect_analysis_view', { source: { kind: 'inline', evidence: {} }, view: { kind: 'summary' } }), TypeError);
});

test('direct blocked names, inline payloads and native observations fail at dispatch validation', () => {
  for (const name of ['open_binary', 'inspect_artifact', 'capture_electron_scenario', 'export_evidence_bundle', 'rea_analyze']) {
    assert.throws(() => call(name, {}), /not allowed/);
  }
  const valid = { application: left, seed: { kind: 'module', value: 'main.js' } };
  assert.equal(call('trace_application_feature', valid).direction, 'both');
  for (const extra of [{ native_observations: [] }, { session_id: 'other' }, { application: { evidence_id: leftId } }, { application: { ...left, evidence: {} } }]) {
    assert.throws(() => call('trace_application_feature', { ...valid, ...extra }), TypeError);
  }
  assert.throws(() => call('trace_application_feature', { ...valid, seed: { kind: 'string', value: '' } }), TypeError);
  assert.equal(call('trace_application_feature', { ...valid, seed: { kind: 'string', value: '', match: 'exact' } }).seed.value, '');
});

test('semantic query validates its true seed contract and relation enums', () => {
  const base = { application: left, query: { seed: { kind: 'property', name: 'status' }, direction: 'forward-influence' } };
  assert.deepEqual(call('trace_javascript_semantics', base).query, {
    seed: { kind: 'property', name: 'status' }, direction: 'forward-influence', include_ambiguous_dynamic_edges: false, expected: null,
  });
  for (const query of [
    { ...base.query, seed: { kind: 'property', value: 'status' } },
    { ...base.query, allowed_relations: ['exec'] },
    { ...base.query, allowed_relations: [] },
    { ...base.query, seed: { kind: 'literal', value: Number.NaN } },
    { ...base.query, seed: { kind: 'literal', value: 'x'.repeat(513) } },
    { ...base.query, max_nodes: 1 },
    { ...base.query, expected: { role: 'sink', classes: ['shell'] } },
  ]) assert.throws(() => call('trace_javascript_semantics', { application: left, query }), TypeError);
});

test('comparisons require two owned distinct parent records and exact selectors', () => {
  assert.deepEqual(call('compare_application_versions', { left, right }), { left, right });
  assert.throws(() => call('compare_application_versions', { left, right: left }), /distinct/);
  assert.throws(() => call('compare_application_versions', { left, right }, new Set([leftId])), /not owned/);
  assert.throws(() => call('compare_application_versions', { left, right, left_native_observations: [] }), TypeError);
  const exportArgs = { left, right, left_module_path: 'a.js', right_module_path: 'b.js', left_export_name: 'read', right_export_name: 'read' };
  assert.deepEqual(call('compare_javascript_export_shapes', exportArgs), exportArgs);
  assert.throws(() => call('compare_javascript_export_shapes', { ...exportArgs, right_export_name: '' }), TypeError);
});

test('schema mutation and unsupported own-property tricks cannot loosen admission', () => {
  const schema = getSchema('inspect_analysis_view');
  schema.properties.source = { type: 'object' };
  assert.throws(() => call('inspect_analysis_view', { source: {}, view: { kind: 'summary' } }), TypeError);
  let invoked = false;
  const getter = { get input_path() { invoked = true; return '/staged/app'; } };
  assert.throws(() => call('analyze_javascript_application', getter), /accessors/);
  assert.equal(invoked, false);
  assert.throws(() => call('analyze_javascript_application', JSON.parse('{"input_path":"/staged/app","__proto__":{}}')), /unsupported/);
  assert.throws(() => call('analyze_javascript_application', Object.create({ input_path: '/staged/app' })), /plain object/);
});

test('public envelope bounds JSON, rejects prototype fields, and blocks alternate acquisition', () => {
  assert.deepEqual(validatePublicCall('rea_discover', {}), {});
  assert.deepEqual(validatePublicCall('rea_read_result', { result_id: 'local-123' }), { result_id: 'local-123', offset: 0, limit: 3000 });
  const request = { tool: 'inspect_analysis_view', arguments: { source: left, view: { kind: 'summary' } } };
  assert.deepEqual(validatePublicCall('rea_call', request), request);
  assert.throws(() => validatePublicCall('rea_call', { ...request, tool: 'analyze_javascript_application' }), TypeError);
  assert.throws(() => validatePublicCall('rea_call', { ...request, token: 'x' }), /unsupported/);
  assert.throws(() => validatePublicCall('rea_call', JSON.parse('{"tool":"inspect_analysis_view","arguments":{"__proto__":{}}}')), /prototype-related/);
  assert.throws(() => validatePublicCall('rea_call', { ...request, arguments: { data: 'a'.repeat(32769) } }), /input limits/);
  assert.throws(() => validatePublicCall('rea_call', { ...request, arguments: { data: new Array(3) } }), /dense bounded/);
  const cycle = {}; cycle.cycle = cycle;
  assert.throws(() => validatePublicCall('rea_call', { ...request, arguments: cycle }), /structure limits/);
  assert.throws(() => validatePublicCall('rea_call', { ...request, arguments: [] }), /plain object/);
  assert.throws(() => validatePublicCall('rea_read_result', { result_id: 'local-123', limit: 6001 }), TypeError);
});
