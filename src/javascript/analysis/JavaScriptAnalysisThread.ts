import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptSourceAnalysisPort, JavaScriptSourceAnalysisLimits,
  JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure,
} from "../../domain/javascript/javascriptSourceAnalysis.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError, AnalysisTimeoutError, AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ok, err, type Result } from "../../domain/result.js";
import { estimateJavaScriptStaticApplicationProjection } from "../../domain/javascript/javascriptApplicationProjectionResources.js";
import { javaScriptWorkerStaticAnalysisSchema } from "./JavaScriptAnalysisWorkerSchemas.js";
import {
  javaScriptWorkerRequestSchema, javaScriptWorkerMessageSchema,
  type JavaScriptWorkerMessage,
} from "./JavaScriptAnalysisWorkerProtocol.js";
import { readJavaScriptAnalysisTransfer, javaScriptTransferRetentionBytes } from "./JavaScriptAnalysisTransfer.js";
import { JAVASCRIPT_THREAD_LIMITS as LIMITS } from "./JavaScriptAnalysisThreadLimits.js";

const OPERATION = "analyze_javascript_application";
const MIB = 1024 * 1024;
type Outcome = Result<JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure>;

/** Opt-in transport for inert source analysis; never starts an OS child process. */
export class JavaScriptAnalysisThread implements JavaScriptSourceAnalysisPort {
  readonly limits: JavaScriptSourceAnalysisLimits;
  readonly #resultBudget: number;
  #retained = 0;
  #active: { controller: AbortController; promise: Promise<Outcome> } | undefined;
  readonly #pendingCleanup = new Map<string, { worker?: Worker; release?: () => void }>();
  #closed = false;

  constructor(limits: JavaScriptSourceAnalysisLimits) {
    if (!Number.isSafeInteger(limits.heapMb) || limits.heapMb < 128 ||
        !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1)
      throw new RangeError("Static thread requires valid heap and timeout limits");
    this.limits = {
      heapMb: Math.min(limits.heapMb, LIMITS.heapMb),
      timeoutMs: Math.min(limits.timeoutMs, LIMITS.timeoutMs),
    };
    this.#resultBudget = Math.max(0, Math.min(LIMITS.resultRetentionBytes,
      Math.floor((getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed - 64 * MIB) / 4)));
  }

  analyze(file: JavaScriptArtifactFile, nodeBudget: number, signal?: AbortSignal): Promise<Outcome> {
    if (this.#closed || this.#active !== undefined || this.#pendingCleanup.size > 0)
      return Promise.resolve(err({ javascript: null, module: null, projection: null,
        error: new AnalysisOutputError(OPERATION, "Static thread adapter is closed, busy, or retains incomplete cleanup") }));
    const controller = new AbortController();
    const forward = () => { controller.abort(new AnalysisCancelledError(OPERATION)); };
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted === true) forward();
    const promise = this.#analyze(file, nodeBudget, controller).finally(() => {
      signal?.removeEventListener("abort", forward);
      this.#active = undefined;
    });
    this.#active = { controller, promise };
    return promise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (active !== undefined) {
      active.controller.abort(new AnalysisCancelledError(OPERATION));
      await active.promise;
    }
    for (const [root, owner] of this.#pendingCleanup) {
      try {
        if (owner.worker !== undefined) {
          await terminateThread(owner.worker);
          owner.release?.();
          this.#pendingCleanup.set(root, {});
        }
        await rm(root, { recursive: true, force: true });
        this.#pendingCleanup.delete(root);
      } catch (cause) {
        throw this.#cleanupError(root, "Static thread resources remain owned", cause);
      }
    }
  }

  async #analyze(file: JavaScriptArtifactFile, nodeBudget: number, controller: AbortController): Promise<Outcome> {
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new AnalysisTimeoutError(OPERATION, this.limits.timeoutMs)), this.limits.timeoutMs);
    let root: string | undefined;
    let worker: Worker | undefined;
    let javascript: JavaScriptStaticAnalysis | null = null;
    let result: Outcome;
    let applicationProjectionFailure: AnalysisResourceConstraintError | undefined;
    let ownedCleanupFailure: ProviderCleanupError | undefined;
    let stopFrames: (() => void) | undefined;
    let assertFrames: (() => void) | undefined;
    const interrupted = () => {
      if (signal.aborted) throw signal.reason;
    };
    try {
      interrupted();
      if (file.kind !== "javascript" || !file.text.included)
        throw new AnalysisOutputError(OPERATION, "Static thread requires decoded JavaScript text");
      if (Buffer.byteLength(file.text.value) > LIMITS.sourceBytes)
        throw this.#resource("Source exceeds the experimental static thread byte limit", { source_bytes: LIMITS.sourceBytes });
      const { text, ...metadata } = file;
      const request = javaScriptWorkerRequestSchema.parse({ id: randomUUID(), node_budget: nodeBudget,
        text_sha256: createHash("sha256").update(text.value).digest("hex"), file: metadata });
      if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.protocolBytes)
        throw this.#resource("Source metadata exceeds the static thread byte limit", { protocol_bytes: LIMITS.protocolBytes });
      root = await mkdtemp(join(tmpdir(), "rea-static-thread-"));
      interrupted();
      await writeFile(join(root, "source"), text.value, { flag: "wx", mode: 0o600, signal });
      interrupted();
      worker = new Worker(new URL("../../composition/javascriptAnalysisWorkerThread.js", import.meta.url), {
        workerData: { root, request }, execArgv: [], env: { NODE_DISABLE_COMPILE_CACHE: "1" },
        stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: this.limits.heapMb, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      });
      const frames = threadFrames(worker, signal);
      stopFrames = frames.close;
      assertFrames = frames.assertHealthy;
      const ready = await frames.next();
      // Explicit startup proof catches inherited CLI heap overrides instead of silently relaxing the cap.
      if (ready.kind !== "ready" || ready.heap_limit_bytes === null ||
          ready.heap_limit_bytes > (this.limits.heapMb + 32) * MIB)
        throw new AnalysisOutputError(OPERATION, "Static thread heap limit or startup handshake is invalid");
      for (;;) {
        const frame = await frames.next();
        if (frame.kind === "ready" || frame.id !== request.id)
          throw new AnalysisOutputError(OPERATION, "Static thread response identity mismatch");
        if (frame.kind === "phase") continue;
        if (frame.kind === "static") {
          if (javascript !== null) throw new AnalysisOutputError(OPERATION, "Duplicate static thread checkpoint");
          javascript = await this.#checkpoint(root, frame);
          interrupted();
          const expanded = estimateJavaScriptStaticApplicationProjection(javascript, frame.bytes, file.path);
          if (expanded > this.#remaining())
            applicationProjectionFailure = this.#resource("Expanded application relationships exceed the static profile budget", {
              application_projection_required_bytes: expanded });
          else this.#retained += expanded;
          worker.postMessage(JSON.stringify({ id: request.id,
            semantic_result_budget_bytes: applicationProjectionFailure === undefined ? this.#remaining() : 0 }));
          continue;
        }
        if (frame.kind === "failure")
          throw frame.reason === "resource"
            ? new AnalysisResourceConstraintError(OPERATION, frame.resource ?? "memory", frame.message,
              { ...frame.limits, worker_timeout_ms: this.limits.timeoutMs })
            : new AnalysisOutputError(OPERATION, frame.message);
        if (javascript === null) throw new AnalysisOutputError(OPERATION, "Static thread completed before a checkpoint");
        if (frame.descriptor === null) {
          result = ok({ javascript, module: null, projection: null });
          break;
        }
        const d = frame.descriptor;
        const retained = javaScriptTransferRetentionBytes(d.module_bytes, d.module_records) +
          javaScriptTransferRetentionBytes(d.graph_bytes, d.graph_records);
        if (d.bytes > LIMITS.transferBytes || retained > this.#remaining())
          throw this.#resource("Static thread result exceeds its remaining retention budget", { transfer_file_bytes: LIMITS.transferBytes });
        const decoded = await readJavaScriptAnalysisTransfer(join(root, "records"), d, file, signal);
        frames.assertHealthy();
        this.#retained += retained;
        interrupted();
        result = ok({ javascript, ...decoded });
        break;
      }
    } catch (cause: unknown) {
      const error = signal.aborted && signal.reason instanceof AnalysisError ? signal.reason
        : cause instanceof AnalysisError ? cause
        : typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? this.#resource("Static analyzer thread reached its V8 heap limit", { worker_old_space_mb: this.limits.heapMb })
          : new AnalysisOutputError(OPERATION, cause instanceof Error ? cause.message : "Static thread failed");
      result = err({ error, javascript, module: null, projection: null });
    } finally {
      clearTimeout(timer);
      // terminate() resolves only after thread exit. Never remove transfer files before that proof.
      if (worker !== undefined) {
        try { await terminateThread(worker); }
        catch (cause: unknown) {
          if (root !== undefined) this.#pendingCleanup.set(root, {
            worker, ...(stopFrames === undefined ? {} : { release: stopFrames }),
          });
          ownedCleanupFailure = this.#cleanupError(root ?? "unknown runtime", "Static thread termination could not be confirmed", cause);
        }
      }
      // Keep error/drain listeners attached to a still-owned live Worker after failed termination.
      if (ownedCleanupFailure === undefined) stopFrames?.();
    }
    if (ownedCleanupFailure !== undefined)
      return err({ error: ownedCleanupFailure, javascript, module: null, projection: null });
    try { if (result.ok) assertFrames?.(); }
    catch (cause) {
      result = err({ error: cause instanceof AnalysisError ? cause :
        new AnalysisOutputError(OPERATION, "Static thread failed during result delivery"), javascript, module: null, projection: null });
    }
    if (!result.ok && javascript === null && root !== undefined) {
      // Preserve an independently validated completed checkpoint if cancellation won before its notification.
      try { javascript = await this.#checkpoint(root); }
      catch { /* An incomplete/missing checkpoint is not evidence. */ }
      result = err({ ...result.error, javascript });
    }
    if (root !== undefined) {
      try { await rm(root, { recursive: true, force: true }); }
      catch (cause: unknown) {
        this.#pendingCleanup.set(root, {});
        return err({ error: this.#cleanupError(root, "Static thread temporary cleanup failed", cause), javascript, module: null, projection: null });
      }
    }
    return applicationProjectionFailure === undefined ? result : result.ok
      ? ok({ ...result.value, applicationProjectionFailure })
      : err({ ...result.error, applicationProjectionFailure });
  }

  #remaining(): number { return Math.max(0, this.#resultBudget - this.#retained); }
  #cleanupError(root: string, reason: string, cause: unknown): ProviderCleanupError {
    return new ProviderCleanupError("javascript-static-thread", [root], { reason }, { cause, operation: OPERATION });
  }
  #resource(reason: string, limits: Record<string, number>): AnalysisResourceConstraintError {
    return new AnalysisResourceConstraintError(OPERATION, "memory", reason,
      { parent_result_budget_bytes: this.#resultBudget, parent_available_result_budget_bytes: this.#remaining(), ...limits });
  }
  async #checkpoint(root: string, expected?: { bytes: number; sha256: string }): Promise<JavaScriptStaticAnalysis> {
    const path = join(root, "static.json");
    const bytes = (await stat(path)).size;
    if (bytes > LIMITS.checkpointBytes || (expected !== undefined && expected.bytes !== bytes))
      throw new AnalysisOutputError(OPERATION, "Static thread checkpoint size mismatch");
    if (bytes * 8 > this.#remaining())
      throw this.#resource("Static checkpoint exceeds remaining parent budget", { checkpoint_bytes: bytes });
    const encoded = await readFile(path, "utf8");
    if (Buffer.byteLength(encoded) !== bytes || (expected !== undefined &&
        createHash("sha256").update(encoded).digest("hex") !== expected.sha256))
      throw new AnalysisOutputError(OPERATION, "Static thread checkpoint digest mismatch");
    const facts = javaScriptWorkerStaticAnalysisSchema.parse(JSON.parse(encoded));
    this.#retained += bytes * 8;
    return facts;
  }
}

/** Retain the owner if shutdown confirmation exceeds the separate cleanup deadline. */
async function terminateThread(worker: Worker): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.terminate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Thread exit was not confirmed within 1000 ms")), 1_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Small authenticated-protocol queue; worker payloads contain no source/graph objects. */
function threadFrames(worker: Worker, signal: AbortSignal) {
  const frames: JavaScriptWorkerMessage[] = [];
  let failure: unknown;
  let exitCode: number | undefined;
  let wake: (() => void) | undefined;
  let outputBytes = 0;
  const fail = (cause: unknown) => { failure ??= cause; wake?.(); };
  const message = (raw: unknown) => {
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMITS.protocolBytes || frames.length >= 16)
        throw new AnalysisOutputError(OPERATION, "Static thread sent an oversized or excessive control frame");
      frames.push(javaScriptWorkerMessageSchema.parse(JSON.parse(raw)));
      wake?.();
    } catch (cause) { fail(cause); }
  };
  const exit = (code: number) => { exitCode = code; wake?.(); };
  const abort = () => { wake?.(); };
  const output = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > LIMITS.outputBytes) fail(new AnalysisOutputError(OPERATION, "Static thread diagnostic output exceeded its byte limit"));
  };
  worker.on("message", message);
  worker.on("error", fail);
  worker.on("exit", exit);
  worker.stdout?.on("data", output);
  worker.stderr?.on("data", output);
  signal.addEventListener("abort", abort);
  return {
    assertHealthy() { if (failure !== undefined) throw failure; },
    async next(): Promise<JavaScriptWorkerMessage> {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if (failure !== undefined) throw failure;
        const frame = frames.shift();
        if (frame !== undefined) return frame;
        if (exitCode !== undefined) throw new AnalysisOutputError(OPERATION, `Static thread exited before a complete result (code ${exitCode})`);
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
    close() {
      worker.off("message", message); worker.off("error", fail); worker.off("exit", exit);
      worker.stdout?.off("data", output); worker.stderr?.off("data", output);
      signal.removeEventListener("abort", abort);
    },
  };
}
