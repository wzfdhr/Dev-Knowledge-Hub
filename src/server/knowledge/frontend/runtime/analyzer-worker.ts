import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { parserAnalyzeRequestSchema, type ParserAnalyzeRequest } from "./parser-protocol.js";
import { VirtualSourceFs } from "./virtual-source-fs.js";

export function analyzeWorkerRequest(raw: unknown) {
  const request = parserAnalyzeRequestSchema.parse(raw) as ParserAnalyzeRequest;
  const sources = new VirtualSourceFs(request.sources);
  return {
    schemaVersion: 1,
    snapshotId: request.snapshotId,
    analyzerIds: [...new Set(request.analyzerIds)].sort(),
    sourcePaths: sources.paths(),
    outputs: []
  };
}

if (!isMainThread) {
  parentPort?.postMessage(analyzeWorkerRequest(workerData));
}
