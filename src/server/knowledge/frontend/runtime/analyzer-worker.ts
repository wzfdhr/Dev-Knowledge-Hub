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
  const data = workerData as { request: unknown; maxOutputBytes: number };
  const payload = Buffer.from(JSON.stringify(analyzeWorkerRequest(data.request)), "utf8");
  if (payload.byteLength > data.maxOutputBytes) {
    parentPort?.postMessage({ type: "error", code: "PARSER_OUTPUT_LIMIT" });
  } else {
    parentPort?.postMessage({ type: "result", payload });
  }
}
