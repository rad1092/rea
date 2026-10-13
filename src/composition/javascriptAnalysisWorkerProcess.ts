import { serveJavaScriptAnalysisWorker } from "../javascript/analysis/JavaScriptAnalysisWorkerServer.js";
import { analyzeJavaScriptSource } from "./javascriptSourceAnalyzer.js";

try {
  await serveJavaScriptAnalysisWorker(analyzeJavaScriptSource);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
