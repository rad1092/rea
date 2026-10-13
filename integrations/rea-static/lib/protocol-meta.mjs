// MCP reserves request params._meta for protocol/client metadata. It is not
// tool input or authority: admit bounded plain JSON here, then discard it.
// https://modelcontextprotocol.io/specification/2025-06-18/basic#meta
export const META_LIMITS = Object.freeze({ bytes: 4096, depth: 8, nodes: 256, progressTokenChars: 128 });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Validate only the tools/call envelope; tool arguments retain their own validators. */
export function admitToolCallParams(params) {
  requirePlainObject(params, 'tools/call params');
  const names = Object.getOwnPropertyNames(params);
  if (names.some(name => !['name', 'arguments', '_meta'].includes(name)) || !Object.hasOwn(params, 'name')) {
    throw new TypeError('Invalid or unsupported tools/call params');
  }
  const fields = {};
  for (const name of names) fields[name] = ownDataValue(params, name);
  if (Object.hasOwn(fields, '_meta')) validateProtocolMeta(fields._meta);
  return {
    name: fields.name,
    ...(Object.hasOwn(fields, 'arguments') ? { arguments: fields.arguments } : {}),
  };
}

/** Exact compact JSON size is counted without invoking user-controlled toJSON. */
export function validateProtocolMeta(meta) {
  requirePlainObject(meta, '_meta');
  const budget = { bytes: 0, nodes: 0 };
  visit(meta, 0, budget);
  if (Object.hasOwn(meta, 'progressToken')) {
    const token = ownDataValue(meta, 'progressToken');
    if (!((typeof token === 'string' && token.length <= META_LIMITS.progressTokenChars)
      || (typeof token === 'number' && Number.isSafeInteger(token)))) {
      throw new TypeError('_meta.progressToken must be a string of at most 128 characters or a safe integer');
    }
  }
}

function visit(value, depth, budget) {
  // Root metadata is depth zero. Each contained JSON value adds one level/node.
  if (depth > META_LIMITS.depth || ++budget.nodes > META_LIMITS.nodes) {
    throw new TypeError('_meta exceeds JSON depth or node limits');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) {
    charge(budget, Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > META_LIMITS.nodes
      || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('_meta arrays must be bounded plain JSON arrays');
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || names.some(name => name !== 'length'
      && (!/^(0|[1-9][0-9]*)$/u.test(name) || Number(name) >= value.length))) {
      throw new TypeError('_meta arrays must be dense and contain no named properties');
    }
    charge(budget, 2);
    for (let i = 0; i < value.length; i++) {
      if (i > 0) charge(budget, 1);
      visit(ownDataValue(value, String(i)), depth + 1, budget);
    }
    return;
  }
  requirePlainObject(value, '_meta values');
  const names = Object.getOwnPropertyNames(value);
  if (names.length > META_LIMITS.nodes) throw new TypeError('_meta exceeds JSON node limits');
  charge(budget, 2);
  for (const [index, name] of names.entries()) {
    if (forbiddenKeys.has(name)) throw new TypeError('_meta contains prototype-related fields');
    charge(budget, Buffer.byteLength(JSON.stringify(name), 'utf8') + 1 + (index > 0 ? 1 : 0));
    visit(ownDataValue(value, name), depth + 1, budget);
  }
}

function charge(budget, bytes) {
  budget.bytes += bytes;
  if (budget.bytes > META_LIMITS.bytes) throw new TypeError('_meta exceeds the 4096-byte JSON limit');
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new TypeError('Protocol params cannot contain accessors or non-JSON properties');
  }
  return descriptor.value;
}
