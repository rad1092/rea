import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JavaScriptAnalysisThread } from '../dist/javascript/analysis/JavaScriptAnalysisThread.js';
import { createJavaScriptSourceAnalysis } from '../dist/artifacts/javascript/JavaScriptSourceAnalysis.js';
import { analyzeJavaScriptSource } from '../dist/composition/javascriptSourceAnalyzer.js';
import { analyzeJavaScriptApplication } from '../dist/application/javascript/JavaScriptApplicationService.js';
import { ArtifactResourceScope } from '../dist/artifacts/ArtifactResourceScope.js';
import { javaScriptWorkerStaticAnalysisSchema } from '../dist/javascript/analysis/JavaScriptAnalysisWorkerSchemas.js';

const suiteRoot = await mkdtemp(join(resolve('.cache/static-thread-test'), 'run-'));
const priorTmp = process.env.TMPDIR;
const priorFlag = process.env.REA_STATIC_WORKER_THREADS;
process.env.TMPDIR = suiteRoot;
const results = [];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const file = (source, path = 'index.js') => ({
  path, bytes: Buffer.byteLength(source), sha256: hash(source), container_sha256: 'a'.repeat(64),
  inventory_artifact_id: 'own-fixture', kind: 'javascript', unpacked: false,
  text: { included: true, value: source },
});
const small = file(`export function add(a, b) { return a + b; }
export async function loadInvoice(id) { const response = await fetch('/api/invoices/' + id); return response.json(); }
`);
const test = async (name, fn) => {
  const start = performance.now();
  await fn();
  const observation = { name, passed: true, elapsed_ms: Math.round(performance.now() - start) };
  results.push(observation); console.log(JSON.stringify(observation));
};
try {
  await test('explicit opt-in only; default constructor preserved without execution', async () => {
    delete process.env.REA_STATIC_WORKER_THREADS;
    const original = createJavaScriptSourceAnalysis({ heapMb: 256, timeoutMs: 5000 }, 1);
    assert.equal(original.constructor.name, 'JavaScriptAnalysisWorker');
    process.env.REA_STATIC_WORKER_THREADS = '1';
    const selected = createJavaScriptSourceAnalysis({ heapMb: 1024, timeoutMs: 300000 }, 1);
    assert.equal(selected.constructor.name, 'JavaScriptAnalysisThread');
    assert.deepEqual(selected.limits, { heapMb: 256, timeoutMs: 5000 });
    await selected.close();
  });
  await test('real parser result equals shared upstream analyzer facts/module/projection', async () => {
    const adapter = new JavaScriptAnalysisThread({ heapMb: 256, timeoutMs: 5000 });
    const observed = await adapter.analyze(small, 2000);
    assert.equal(observed.ok, true, observed.ok ? '' : observed.error.error.message);
    let facts;
    const expected = await analyzeJavaScriptSource(small, 2000, {
      phase: async () => {}, checkpoint: async (value) => { facts = value; return 64 * 1024 * 1024; },
    });
    assert.deepEqual(observed.value.javascript, javaScriptWorkerStaticAnalysisSchema.parse(facts));
    assert.deepEqual(observed.value.module, expected.module);
    assert.deepEqual(observed.value.projection, expected.projection);
    assert.ok(observed.value.module.callables.length >= 2);
    await adapter.close();
  });
  await test('target source is inert and cannot create a marker', async () => {
    const marker = join(suiteRoot, 'target-executed');
    const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'EXECUTED');\nthrow new Error('must never execute');\nexport const value = 42;`;
    const adapter = new JavaScriptAnalysisThread({ heapMb: 256, timeoutMs: 5000 });
    const observed = await adapter.analyze(file(source), 2000);
    assert.equal(observed.ok, true, observed.ok ? '' : observed.error.error.message);
    assert.equal(existsSync(marker), false);
    await adapter.close();
  });
  await test('pre-cancellation creates no worker runtime; 1ms timeout returns tagged error', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const adapter = new JavaScriptAnalysisThread({ heapMb: 128, timeoutMs: 5000 });
    const result = await adapter.analyze(small, 2000, cancelled.signal);
    assert.equal(result.ok, false); assert.equal(result.error.error._tag, 'AnalysisCancelledError');
    await adapter.close();
    const fast = new JavaScriptAnalysisThread({ heapMb: 128, timeoutMs: 1 });
    const start = performance.now();
    const timeout = await fast.analyze(small, 2000);
    assert.equal(timeout.ok, false); assert.equal(timeout.error.error._tag, 'AnalysisTimeoutError');
    assert.ok(performance.now() - start < 2000);
    await fast.close();
  });
  await test('in-flight cancellation preserves a completed checkpoint and supports restart', async () => {
    const source = Array.from({ length: 3500 }, (_, i) => `function value${i}(x) { return x + ${i}; }`).join('\n');
    const adapter = new JavaScriptAnalysisThread({ heapMb: 256, timeoutMs: 5000 });
    const controller = new AbortController();
    let checkpointSeen = false;
    const poll = setInterval(() => {
      for (const name of readdirSync(suiteRoot)) {
        if (name.startsWith('rea-static-thread-') && existsSync(join(suiteRoot, name, 'static.json'))) {
          try {
            JSON.parse(readFileSync(join(suiteRoot, name, 'static.json'), 'utf8'));
            checkpointSeen = true; controller.abort(); break;
          } catch { /* File creation can precede the complete checkpoint write. */ }
        }
      }
    }, 2);
    let cancelled;
    try { cancelled = await adapter.analyze(file(source), 10000, controller.signal); }
    finally { clearInterval(poll); }
    assert.equal(checkpointSeen, true, 'fixture must reach a real static checkpoint');
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.error._tag, 'AnalysisCancelledError');
    assert.ok(cancelled.error.javascript, 'completed static facts retained');
    const restarted = await adapter.analyze(small, 2000);
    assert.equal(restarted.ok, true, restarted.ok ? '' : restarted.error.error.message);
    await adapter.close();
    const afterClose = await adapter.analyze(small, 2000);
    assert.equal(afterClose.ok, false);
  });
  await test('source input bound rejects before worker allocation', async () => {
    const adapter = new JavaScriptAnalysisThread({ heapMb: 256, timeoutMs: 5000 });
    const result = await adapter.analyze(file(' '.repeat(4 * 1024 * 1024 + 1)), 2000);
    assert.equal(result.ok, false); assert.equal(result.error.error._tag, 'AnalysisResourceConstraintError');
    await adapter.close();
  });
  await test('existing full application pipeline produces real Evidence through opt-in adapter', async () => {
    const fixture = join(suiteRoot, 'fixture'); await mkdir(fixture);
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'owned-static-fixture', type: 'module', main: 'index.js' }));
    await writeFile(join(fixture, 'index.js'), small.text.value);
    const scope = new ArtifactResourceScope();
    const result = await analyzeJavaScriptApplication({ input_path: fixture, format: 'directory', integrity_policy: 'fail' }, scope);
    assert.equal(result.ok, true, result.ok ? '' : result.error.message);
    assert.equal(result.value.operation, 'analyze_javascript_application');
    assert.ok(result.value.normalized_result.statistics.parsed_javascript_files > 0);
    await scope.close();
    await rm(fixture, { recursive: true });
  });
  await test('all owned worker temporary directories removed', async () => {
    assert.deepEqual(await readdir(suiteRoot), []);
  });
  const report = { passed: results.length, results, node: process.version, adapter: 'experimental-worker-threads' };
  await writeFile(resolve('.cache/static-thread-test/results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: results.length, report: '.cache/static-thread-test/results.json' }));
} finally {
  if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
  if (priorFlag === undefined) delete process.env.REA_STATIC_WORKER_THREADS; else process.env.REA_STATIC_WORKER_THREADS = priorFlag;
  await rm(suiteRoot, { recursive: true, force: true });
}
