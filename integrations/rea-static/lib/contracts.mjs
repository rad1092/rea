/** Narrow contracts reviewed against morluto/rea a6efa4fcefeffcf5ff5310b8154988b4be30c349. */
export const UPSTREAM_PIN = 'a6efa4fcefeffcf5ff5310b8154988b4be30c349';

export const ALLOWED_TOOLS = Object.freeze([
  'analyze_javascript_application',
  'inspect_analysis_view',
  'trace_application_feature',
  'trace_javascript_semantics',
  'compare_application_versions',
  'compare_javascript_export_shapes',
]);

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const string = (maxLength = 1024, minLength = 1) => ({
  type: 'string', minLength, maxLength, pattern: '^[^\\u0000]*$',
});
const enumeration = (...values) => ({ type: 'string', enum: values });
const constant = value => ({ type: typeof value, const: value });
const integer = (minimum, maximum, defaultValue) => ({
  type: 'integer', minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const digest = prefix => ({
  type: 'string', pattern: prefix ? `^${prefix}_[a-f0-9]{64}$` : '^[a-f0-9]{64}$',
  minLength: prefix ? prefix.length + 65 : 64,
  maxLength: prefix ? prefix.length + 65 : 64,
});
const array = (items, maxItems, minItems = 1) => ({
  type: 'array', items, minItems, maxItems,
});
const ref = object({ kind: constant('retained-evidence'), evidence_id: digest('ev') });
const sourcePaths = array(string(1024), 64);
const boolDefault = value => ({ type: 'boolean', default: value });
const featureKinds = ['node-id', 'route', 'string', 'api', 'channel', 'module', 'native-export'];
const semanticRelations = [
  'acquires', 'aggregates', 'aliases', 'argument-to-parameter', 'awaits', 'calls',
  'cancels-timer', 'captures', 'chains', 'coerces', 'connects-stdio', 'consumed-by',
  'constructs-request', 'creates-promise', 'defaults', 'defines', 'destructures',
  'detaches-task', 'dispatches-candidate', 'forwards-signal', 'listens-error',
  'listens-exit', 'owns', 'overrides', 'parses', 'reads', 'reads-argv',
  'reads-config', 'reads-environment', 'reads-property', 'registers-listener',
  'releases', 'removes-listener', 'returns-task', 'returns-to-call',
  'schedules-timer', 'spawns', 'spreads', 'supplies-argv', 'supplies-env',
  'supplies-request-field', 'validates', 'writes', 'writes-property',
];
const semanticClasses = [
  'module', 'function', 'parameter', 'binding', 'expression', 'literal',
  'property-slot', 'call-site', 'return-site', 'closure-capture', 'promise',
  'task', 'event', 'listener', 'timer', 'child-process', 'stdio', 'signal',
  'config-source', 'request', 'response', 'boundary', 'resource', 'unknown-frontier',
];

const semanticSeed = { anyOf: [
  object({ kind: constant('semantic-node'), node_id: digest('jsrg_node') }),
  object({ kind: constant('application-node'), node_id: digest('jag_node') }),
  object({ kind: constant('literal'), value: { anyOf: [
    string(512, 0), { type: 'number' }, { type: 'boolean' }, { type: 'null' },
  ] } }),
  object({ kind: constant('function'), fingerprint_sha256: digest('') }),
  object({ kind: constant('property'), name: string(512) }),
  object({ kind: constant('endpoint'), value: string(1024) }),
  object({ kind: constant('event'), name: string(512) }),
  object({ kind: constant('boundary-field'), field: string(512) }),
] };

const schemas = {
  analyze_javascript_application: object({
    input_path: string(4096),
    source_paths: sourcePaths,
    format: { ...constant('directory'), default: 'directory' },
    detail: { ...constant('summary'), default: 'summary' },
    integrity_policy: { ...constant('fail'), default: 'fail' },
    max_semantic_nodes: integer(1, 5000, 5000),
    max_semantic_nodes_per_file: integer(1, 1000, 1000),
    max_heap_mb: integer(128, 256, 256),
    analysis_timeout_ms: integer(1, 5000, 5000),
  }, ['input_path']),
  inspect_analysis_view: object({
    source: ref,
    view: { anyOf: [
      object({ kind: constant('summary') }),
      object({
        kind: constant('page'), collection: constant('modules'),
        offset: integer(0, 1_000_000, 0), limit: integer(1, 20, 10),
      }, ['kind', 'collection']),
      object({
        kind: constant('item'), collection: constant('modules'),
        selector: { anyOf: [object({ path: string(1024, 0) }), object({ node_id: digest('jag_node') })] },
      }),
    ] },
  }),
  trace_application_feature: object({
    application: ref,
    seed: { anyOf: [
      object({
        kind: enumeration(...featureKinds), value: string(512),
        match: { anyOf: [enumeration('exact', 'contains'), { type: 'null' }], default: null },
        case_sensitive: boolDefault(false),
      }, ['kind', 'value']),
      object({
        kind: enumeration(...featureKinds.slice(1)), value: constant(''),
        match: constant('exact'), case_sensitive: boolDefault(false),
      }, ['kind', 'value', 'match']),
    ] },
    direction: { ...enumeration('outgoing', 'incoming', 'both'), default: 'both' },
  }, ['application', 'seed']),
  trace_javascript_semantics: object({
    application: ref,
    query: object({
      seed: semanticSeed,
      direction: enumeration('backward-provenance', 'forward-influence', 'callers', 'ownership'),
      allowed_relations: array(enumeration(...semanticRelations), semanticRelations.length),
      include_ambiguous_dynamic_edges: boolDefault(false),
      expected: { anyOf: [
        object({ role: enumeration('source', 'sink'), classes: array(enumeration(...semanticClasses), semanticClasses.length) }),
        { type: 'null' },
      ], default: null },
    }, ['seed', 'direction']),
  }),
  compare_application_versions: object({ left: ref, right: ref }),
  compare_javascript_export_shapes: object({
    left: ref, right: ref,
    left_module_path: string(1024), left_export_name: string(512),
    right_module_path: string(1024), right_export_name: string(512),
  }),
};

const descriptions = {
  analyze_javascript_application: 'Static JavaScript directory analysis. Summary, fail-on-integrity and worker limits are enforced. Use parent_evidence_id for follow-ups.',
  inspect_analysis_view: 'Read a summary, module page (up to 20 rows), or exact module of retained analysis.',
  trace_application_feature: 'Trace a literal route, API, channel, module, string, or graph node through retained static evidence.',
  trace_javascript_semantics: 'Trace provenance, influence, callers, or ownership in a retained static semantic graph. Reachability is not execution.',
  compare_application_versions: 'Compare two distinct retained JavaScript analyses, preserving partial coverage and uncertainty.',
  compare_javascript_export_shapes: 'Compare statically recovered return shapes for exact exports in two distinct retained analyses.',
};

/** Compact initial catalog; full tool contracts are supplied only on discovery. */
export const publicTools = deepFreeze([
  {
    name: 'rea_analyze',
    description: 'Analyze an authorized local JavaScript directory statically. Only paths under the configured analysis root are accepted; execution and network are disabled. Returns a summary and session evidence reference.',
    inputSchema: object({ input_path: string(4096), source_paths: sourcePaths }, ['input_path']),
  },
  {
    name: 'rea_discover',
    description: 'List the six static analysis operations, or get the bounded argument schema for one operation before calling it.',
    inputSchema: object({ tool: enumeration(...ALLOWED_TOOLS) }, []),
  },
  {
    name: 'rea_call',
    description: 'Call a discovered static operation with its exact arguments. Only evidence retained in this session is accepted. Use rea_analyze to acquire new evidence.',
    inputSchema: object({
      tool: enumeration(...ALLOWED_TOOLS.filter(name => name !== 'analyze_javascript_application')),
      arguments: { type: 'object', description: 'Arguments matching the exact bounded schema returned by rea_discover.' },
    }),
  },
  {
    name: 'rea_read_result',
    description: 'Read a bounded text page of a complete result retained in this process. A receipt supplies result_id; offsets count JavaScript UTF-16 code units.',
    inputSchema: object({
      result_id: string(200), offset: integer(0, Number.MAX_SAFE_INTEGER, 0),
      limit: integer(1, 6000, 3000),
    }, ['result_id']),
  },
]);

deepFreeze(schemas);

/** A detached schema prevents callers from changing subsequent admission checks. */
export function getSchema(tool) {
  requireAllowed(tool);
  return structuredClone(schemas[tool]);
}

export function getToolSummary(tool) {
  requireAllowed(tool);
  return { name: tool, description: descriptions[tool] };
}

/** Admit the compact public envelope before tool-specific dispatch validation. */
export function validatePublicCall(name, args) {
  const tool = publicTools.find(candidate => candidate.name === name);
  if (tool === undefined) throw new TypeError('Public operation is not allowed');
  // Copy data without invoking accessors before measuring or forwarding it.
  const value = copyJson(args, { nodes: 0 }, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32 * 1024) {
    throw new TypeError('Public arguments exceed the 32 KiB input limit');
  }
  return validateValue(tool.inputSchema, value, 'arguments');
}

/** Validate all accepted fields and produce a fresh upstream-only argument object. */
export function validateCall(tool, args, ownedEvidence) {
  requireAllowed(tool);
  const result = validateValue(schemas[tool], args, 'arguments');
  if (!(ownedEvidence instanceof Set)) throw new TypeError('ownedEvidence must be a session-local Set');
  const references = tool === 'inspect_analysis_view' ? [result.source]
    : tool.startsWith('trace_') ? [result.application]
      : tool.startsWith('compare_') ? [result.left, result.right] : [];
  for (const reference of references) {
    if (!ownedEvidence.has(reference.evidence_id)) throw new TypeError('Evidence is not owned by this session');
  }
  if (result.left && result.right && result.left.evidence_id === result.right.evidence_id) {
    throw new TypeError('Comparison requires two distinct evidence IDs');
  }
  if (tool === 'analyze_javascript_application' && result.source_paths) {
    for (const path of result.source_paths) {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
        throw new TypeError('source_paths must be exact relative inventory paths without traversal');
      }
    }
    if (new Set(result.source_paths).size !== result.source_paths.length) {
      throw new TypeError('source_paths must be unique');
    }
  }
  return result;
}

function requireAllowed(tool) {
  if (typeof tool !== 'string' || !ALLOWED_TOOLS.includes(tool)) throw new TypeError('Operation is not allowed by the static profile');
}

function validateValue(schema, value, path) {
  if (value === undefined && Object.hasOwn(schema, 'default')) return structuredClone(schema.default);
  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      try { return validateValue(candidate, value, path); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    throw new TypeError(`${path} does not match an allowed shape`);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new TypeError(`${path} has a disallowed value`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${path} has a disallowed value`);
  if (schema.type === 'null') {
    if (value !== null) throw new TypeError(`${path} must be null`);
    return null;
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
      throw new TypeError(`${path} must be a plain object`);
    }
    if (schema.properties === undefined && schema.additionalProperties !== false) {
      return copyJson(value, { nodes: 0 }, 0);
    }
    const allowed = schema.properties ?? {};
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${path} has unsupported properties`);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!Object.hasOwn(allowed, key)) throw new TypeError(`${path} has unsupported properties`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(`${path} cannot contain accessors`);
    }
    const result = {};
    for (const [key, child] of Object.entries(allowed)) {
      if (!Object.hasOwn(value, key)) {
        if (Object.hasOwn(child, 'default')) result[key] = structuredClone(child.default);
        else if (schema.required.includes(key)) throw new TypeError(`${path}.${key} is required`);
      } else result[key] = validateValue(child, value[key], `${path}.${key}`);
    }
    return result;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new TypeError(`${path} has an invalid array length`);
    return value.map((item, index) => validateValue(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value))) {
      throw new TypeError(`${path} must be an allowed bounded string`);
    }
    return value;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
      throw new TypeError(`${path} must be an allowed bounded number`);
    }
    return value;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${path} must be boolean`);
    return value;
  }
  throw new TypeError('Unsupported internal schema');
}

function copyJson(value, budget, depth) {
  if (++budget.nodes > 4096 || depth > 16) throw new TypeError('Public arguments exceed JSON structure limits');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (value.length > 32 * 1024) throw new TypeError('Public string exceeds input limits');
    return value;
  }
  if (typeof value !== 'object' || value === null) throw new TypeError('Public arguments must be plain JSON');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('Public arguments cannot contain symbol properties');
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Public arguments must be plain JSON objects');
  }
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (value.length > 4096 || Object.keys(value).length !== value.length)) {
    throw new TypeError('Public arrays must be dense bounded JSON arrays');
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Public arguments contain prototype-related fields');
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) {
      throw new TypeError('Public arrays cannot contain named properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Public arguments cannot contain accessors');
    result[key] = copyJson(descriptor.value, budget, depth + 1);
  }
  return result;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
