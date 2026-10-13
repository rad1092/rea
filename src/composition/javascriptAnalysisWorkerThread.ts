import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { z } from "zod";
import { analyzeJavaScriptSource } from "./javascriptSourceAnalyzer.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { javaScriptWorkerStaticAnalysisSchema } from "../javascript/analysis/JavaScriptAnalysisWorkerSchemas.js";
import { writeJavaScriptAnalysisTransfer } from "../javascript/analysis/JavaScriptAnalysisTransfer.js";
import {
  javaScriptWorkerRequestSchema,
  javaScriptWorkerAdmissionSchema,
  javaScriptWorkerMessageSchema,
  type JavaScriptWorkerMessage,
} from "../javascript/analysis/JavaScriptAnalysisWorkerProtocol.js";
import { JAVASCRIPT_THREAD_LIMITS as LIMITS } from "../javascript/analysis/JavaScriptAnalysisThreadLimits.js";

const port = parentPort;
if (port === null) throw new Error("The static analyzer requires a parent thread");
const { root, request } = z.strictObject({
  root: z.string(),
  request: javaScriptWorkerRequestSchema,
}).parse(workerData);

const send = (input: JavaScriptWorkerMessage): void => {
  const frame = JSON.stringify(javaScriptWorkerMessageSchema.parse(input));
  if (Buffer.byteLength(frame) > LIMITS.protocolBytes)
    throw new RangeError("Static thread control frame exceeds its byte limit");
  port.postMessage(frame);
};

try {
  send({ kind: "ready", heap_limit_bytes: getHeapStatistics().heap_size_limit });
  const text = await readFile(join(root, "source"), "utf8");
  if (Buffer.byteLength(text) > LIMITS.sourceBytes ||
      createHash("sha256").update(text).digest("hex") !== request.text_sha256)
    throw new TypeError("Static thread source failed size or digest validation");
  const result = await analyzeJavaScriptSource(
    { ...request.file, text: { included: true, value: text } },
    request.node_budget,
    {
      phase: async (phase) => { send({ kind: "phase", id: request.id, phase }); },
      checkpoint: async (facts) => {
        const encoded = JSON.stringify(javaScriptWorkerStaticAnalysisSchema.parse(facts));
        const bytes = Buffer.byteLength(encoded);
        if (bytes > LIMITS.checkpointBytes)
          throw new AnalysisResourceConstraintError(
            "analyze_javascript_application", "transport",
            "Static thread checkpoint exceeds its byte limit",
            { checkpoint_bytes: LIMITS.checkpointBytes },
          );
        await writeFile(join(root, "static.json"), encoded, { flag: "wx", mode: 0o600 });
        // Subscribe before publishing the checkpoint: admission cannot race the listener.
        const admission = new Promise<number>((resolve, reject) => {
          port.once("message", (raw: unknown) => {
            try {
              if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMITS.protocolBytes)
                throw new TypeError("Invalid static thread admission frame");
              const parsed = javaScriptWorkerAdmissionSchema.parse(JSON.parse(raw));
              if (parsed.id !== request.id || parsed.semantic_result_budget_bytes > LIMITS.resultRetentionBytes)
                throw new TypeError("Static thread admission identity or budget mismatch");
              resolve(parsed.semantic_result_budget_bytes);
            } catch (cause) { reject(cause); }
          });
        });
        send({ kind: "static", id: request.id, bytes,
          sha256: createHash("sha256").update(encoded).digest("hex") });
        return admission;
      },
    },
  );
  const descriptor = result === null ? null : await writeJavaScriptAnalysisTransfer(
    join(root, "records"), result.module, result.projection, LIMITS.transferBytes,
  );
  send({ kind: "complete", id: request.id, descriptor });
} catch (cause: unknown) {
  send({ kind: "failure", id: request.id,
    reason: cause instanceof AnalysisResourceConstraintError || cause instanceof RangeError ? "resource" : "output",
    resource: cause instanceof AnalysisResourceConstraintError ? cause.resource : cause instanceof RangeError ? "memory" : null,
    limits: cause instanceof AnalysisResourceConstraintError ? cause.reportedLimits : null,
    message: (cause instanceof Error ? cause.message : "Static thread analysis failed").slice(0, 2048),
  });
} finally {
  port.close();
}
