import type {
  JavaScriptSourceAnalysisLimits,
  JavaScriptSourceAnalysisPort,
} from "../../domain/javascript/javascriptSourceAnalysis.js";
import { JavaScriptAnalysisWorker } from "../../javascript/analysis/JavaScriptAnalysisWorker.js";
import { JavaScriptAnalysisThread } from "../../javascript/analysis/JavaScriptAnalysisThread.js";

/** Construct the inert artifact analyzer; resources are acquired on the first source. */
export const createJavaScriptSourceAnalysis = (
  limits: JavaScriptSourceAnalysisLimits,
  sourceCount: number,
): JavaScriptSourceAnalysisPort =>
  process.env.REA_STATIC_WORKER_THREADS === "1"
    ? new JavaScriptAnalysisThread(limits)
    : new JavaScriptAnalysisWorker(limits, undefined, sourceCount);
