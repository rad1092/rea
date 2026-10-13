import test from 'node:test';
import assert from 'node:assert/strict';
import { META_LIMITS, admitToolCallParams, validateProtocolMeta } from '../lib/protocol-meta.mjs';
import { validatePublicCall, validateCall } from '../lib/contracts.mjs';

test('tools/call metadata is admitted and dropped without changing tool arguments', () => {
  const args = { tool: 'inspect_analysis_view' };
  const metadata = { progressToken: 'request-123', 'example.com/request': { correlationId: 'local', flags: [true, null, 0.5] } };
  const params = { name: 'rea_discover', arguments: args, _meta: metadata };
  const admitted = admitToolCallParams(params);
  assert.deepEqual(admitted, { name: 'rea_discover', arguments: args });
  assert.strictEqual(admitted.arguments, args);
  assert.equal(Object.hasOwn(admitted, '_meta'), false);
  assert.strictEqual(params._meta, metadata);
  assert.deepEqual(admitToolCallParams({ name: 'rea_discover' }), { name: 'rea_discover' });
  assert.deepEqual(admitToolCallParams({ name: 'rea_discover', _meta: {} }), { name: 'rea_discover' });
  assert.deepEqual(validatePublicCall(admitted.name, admitted.arguments), args);
});

test('metadata cannot authorize a blocked tool, foreign evidence, or tool-argument _meta', () => {
  const blocked = admitToolCallParams({ name: 'open_binary', arguments: {}, _meta: { authorized: true } });
  assert.throws(() => validatePublicCall(blocked.name, blocked.arguments), /not allowed/);
  const illegalArgs = admitToolCallParams({ name: 'rea_discover', arguments: { _meta: {} }, _meta: {} });
  assert.throws(() => validatePublicCall(illegalArgs.name, illegalArgs.arguments), /unsupported/);
  const foreignId = `ev_${'f'.repeat(64)}`;
  const request = admitToolCallParams({ name: 'rea_call', arguments: {
    tool: 'inspect_analysis_view', arguments: { source: { kind: 'retained-evidence', evidence_id: foreignId }, view: { kind: 'summary' } },
  }, _meta: { evidence_id: foreignId, authorized: true } });
  const publicArgs = validatePublicCall(request.name, request.arguments);
  assert.throws(() => validateCall(publicArgs.tool, publicArgs.arguments, new Set()), /not owned/);
  for (const extra of [{ authorization: true }, { progressToken: 'wrong-level' }, { _meta_extra: {} }]) {
    assert.throws(() => admitToolCallParams({ name: 'rea_discover', ...extra }), /unsupported/);
  }
});

test('metadata enforces exact serialized UTF-8 bytes, including escaped strings and keys', () => {
  const exact = { x: 'a'.repeat(META_LIMITS.bytes - 8) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 4096);
  assert.doesNotThrow(() => validateProtocolMeta(exact));
  assert.throws(() => validateProtocolMeta({ x: exact.x + 'a' }), /4096-byte/);
  const unicode = { x: '한'.repeat(1362) + 'aa' };
  assert.equal(Buffer.byteLength(JSON.stringify(unicode)), 4096);
  assert.doesNotThrow(() => validateProtocolMeta(unicode));
  assert.throws(() => validateProtocolMeta({ x: unicode.x + '한' }), /4096-byte/);
  const escaped = { x: '\n'.repeat(2044) };
  assert.equal(Buffer.byteLength(JSON.stringify(escaped)), 4096);
  assert.doesNotThrow(() => validateProtocolMeta(escaped));
  assert.throws(() => validateProtocolMeta({ x: escaped.x + '\n' }), /4096-byte/);
  assert.throws(() => validateProtocolMeta({ ['k'.repeat(4096)]: null }), /4096-byte/);
});

test('metadata enforces depth and node limits independently from byte limits', () => {
  const nested = depth => { let value = null; for (let i = 0; i < depth; i++) value = { child: value }; return value; };
  assert.doesNotThrow(() => validateProtocolMeta(nested(8)));
  assert.throws(() => validateProtocolMeta(nested(9)), /depth or node/);
  assert.doesNotThrow(() => validateProtocolMeta({ items: Array(254).fill(null) }));
  assert.throws(() => validateProtocolMeta({ items: Array(255).fill(null) }), /depth or node/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => validateProtocolMeta(cycle), /depth or node/);
});

test('only a bounded string or safe integer is admitted as root progressToken', () => {
  for (const token of ['', 'a'.repeat(128), 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    assert.doesNotThrow(() => validateProtocolMeta({ progressToken: token }));
  }
  for (const token of ['a'.repeat(129), 0.5, Number.MAX_SAFE_INTEGER + 1, null, {}, [], true]) {
    assert.throws(() => validateProtocolMeta({ progressToken: token }), /progressToken/);
  }
  for (const token of [Number.NaN, Infinity, undefined, 1n, () => 'token']) {
    assert.throws(() => validateProtocolMeta({ progressToken: token }), TypeError);
  }
  // A similarly named nested application field is arbitrary JSON, not a protocol token.
  assert.doesNotThrow(() => validateProtocolMeta({ trace: { progressToken: { state: 'unknown' } } }));
});

test('metadata rejects prototype fields at every nesting level and requires a JSON object root', () => {
  for (const field of ['__proto__', 'constructor', 'prototype']) {
    const value = JSON.parse(`{"nested":[{"${field}":true}]}`);
    assert.throws(() => validateProtocolMeta(value), /prototype-related/);
  }
  for (const invalid of [null, [], 'text', true, 1, undefined, new Date(), Object.create({ inherited: true })]) {
    assert.throws(() => validateProtocolMeta(invalid), /plain JSON/);
  }
  assert.doesNotThrow(() => validateProtocolMeta(Object.assign(Object.create(null), { context: 'local' })));
  assert.throws(() => validateProtocolMeta({ trace: Object.create({ inherited: true }) }), /plain JSON/);
  assert.throws(() => validateProtocolMeta({ trace: { [Symbol('secret')]: true } }), /plain JSON/);
});

test('accessors, toJSON functions, sparse arrays and extra array properties are never invoked or ignored', () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'trace', { enumerable: true, get() { invoked++; return {}; } });
  assert.throws(() => validateProtocolMeta(getter), /accessors/);
  assert.throws(() => admitToolCallParams({ name: 'rea_discover', get _meta() { invoked++; return {}; } }), /accessors/);
  assert.throws(() => validateProtocolMeta({ toJSON() { invoked++; return {}; } }), /plain JSON/);
  assert.equal(invoked, 0);
  assert.throws(() => validateProtocolMeta({ trace: new Array(2) }), /dense/);
  const named = [0]; named.extra = true;
  assert.throws(() => validateProtocolMeta({ trace: named }), /dense/);
  const arrayGetter = Object.defineProperty([0], '0', { enumerable: true, get() { invoked++; return null; } });
  assert.throws(() => validateProtocolMeta({ trace: arrayGetter }), /accessors/);
  const hidden = Object.defineProperty({}, 'trace', { value: true, enumerable: false });
  assert.throws(() => validateProtocolMeta(hidden), /non-JSON/);
  assert.equal(invoked, 0);
});
