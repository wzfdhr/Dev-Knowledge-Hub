import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { z } from "zod";

import { parserAnalyzeRequestSchema, type ParserAnalyzeRequest } from "./parser-protocol.js";
import { VirtualSourceFs } from "./virtual-source-fs.js";
import { AnalyzerRegistry } from "../analyzer-registry.js";
import { analyzeHtmlSource } from "../html-analyzer.js";
import { analyzeFrontendProjectManifest, type FrontendProjectManifest } from "../project-manifest.js";
import { analyzeProjectStructure } from "../project-structure-analyzer.js";
import { analyzeReactSource } from "../react-analyzer.js";
import { analyzeReactRouterSource } from "../react-router-analyzer.js";
import { analyzeStateDataSource } from "../state-data-analyzer.js";
import { analyzeStyleSource } from "../style-analyzer.js";
import { analyzeToolingTestSource } from "../tooling-test-analyzer.js";
import { analyzeTypeScriptSource } from "../typescript-analyzer.js";
import { analyzeVisualizationSource } from "../visualization-analyzer.js";
import {
  createRestrictedTypeScriptProgram,
  extractTypeScriptSyntaxFacts,
  typeScriptSyntaxParserConfigDigest
} from "../typescript-program.js";

export const MAX_ANALYZER_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_ANALYZER_OUTPUT_NODES = 250_000;
export const MAX_ANALYZER_OUTPUT_DEPTH = 256;

export interface AnalyzerOutputStructureLimits {
  maxNodes: number;
  maxDepth: number;
}

export function assertAnalyzerOutputStructure(
  value: unknown,
  limits: AnalyzerOutputStructureLimits
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new Error("Parser worker output exceeds node limit");
    if (current.depth > limits.maxDepth) throw new Error("Parser worker output exceeds depth limit");
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) throw new Error("Parser worker output contains a cycle");
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        if (nodes + stack.length >= limits.maxNodes) throw new Error("Parser worker output exceeds node limit");
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    for (const key in current.value) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      if (nodes + stack.length >= limits.maxNodes) throw new Error("Parser worker output exceeds node limit");
      stack.push({
        value: (current.value as Record<string, unknown>)[key],
        depth: current.depth + 1
      });
    }
  }
}

export function analyzeWorkerRequest(raw: unknown) {
  const request = parserAnalyzeRequestSchema.parse(raw) as ParserAnalyzeRequest;
  const sources = new VirtualSourceFs(request.sources);
  const projectSources = sources.paths().map((sourcePath) => ({
    path: sourcePath,
    content: sources.readText(sourcePath)
  }));
  const requested = new Set(request.analyzerIds);
  const outputs = requested.has("frontend-project") ? [analyzeFrontendProject(projectSources, request)] : [];
  return {
    schemaVersion: 1,
    snapshotId: request.snapshotId,
    analyzerIds: [...new Set(request.analyzerIds)].sort(),
    sourcePaths: sources.paths(),
    outputs
  };
}

function analyzeFrontendProject(
  projectSources: Array<{ path: string; content: string }>,
  request: ParserAnalyzeRequest
) {
  const sourceHashes = new Map(request.sources.map((source) => [source.path, source.blobHash.toLowerCase()]));
  const cached = new Map((request.cachedAnalyses ?? []).map((entry) => [
    `${entry.path}\0${entry.blobHash}\0${entry.parserConfigDigest}`,
    entry.facts
  ]));
  const typed = createRestrictedTypeScriptProgram(projectSources);
  const projectManifest = analyzeFrontendProjectManifest(projectSources);
  const sourceHash = (sourcePath: string) => {
    const value = sourceHashes.get(sourcePath);
    if (!value) throw new Error("TypeScript Program source hash is unavailable");
    return value;
  };
  return {
    analyzerId: "typescript-project",
    analyzerVersion: "1.0.0",
    projectManifest,
    projectReferences: typed.projectReferences,
    resolutions: typed.resolutions,
    files: typed.rootNames.map((sourcePath) => ({
      path: sourcePath,
      blobHash: sourceHash(sourcePath),
      parserConfigDigest: typeScriptSyntaxParserConfigDigest(sourcePath),
      facts: cached.get([
        sourcePath,
        sourceHash(sourcePath),
        typeScriptSyntaxParserConfigDigest(sourcePath)
      ].join("\0")) ?? extractTypeScriptSyntaxFacts(sourcesText(projectSources, sourcePath), sourcePath)
    })),
    frontendIr: analyzeFrontendIr(
      projectSources,
      sourceHashes,
      request.snapshotId,
      projectManifest,
      typed.resolutions,
      new Set(request.analyzerIds)
    )
  };
}

function packageKeyForPath(projectManifest: FrontendProjectManifest, sourcePath: string): string {
  const owner = projectManifest.packages.filter((candidate) =>
    candidate.root === "" || sourcePath.startsWith(`${candidate.root}/`)
  ).sort((left, right) => right.root.length - left.root.length)[0];
  return owner?.name || owner?.root || "workspace";
}

function analyzeFrontendIr(
  sources: Array<{ path: string; content: string }>,
  sourceHashes: ReadonlyMap<string, string>,
  snapshotId: string,
  projectManifest: FrontendProjectManifest,
  resolutions: Array<{ containingFile: string; specifier: string; resolvedPath: string | null }>,
  requestedAnalyzers: ReadonlySet<string>
) {
  const outputs = [
    ...(requestedAnalyzers.has("frontend-project-core") ? analyzeProjectStructure({
      snapshotId,
      sources: sources.map((source) => ({ ...source, blobHash: sourceHashes.get(source.path)! }))
    }) : []),
    ...sources.flatMap((source) => {
    const blobHash = sourceHashes.get(source.path);
    if (!blobHash) throw new Error("Frontend analyzer source hash is unavailable");
    const base = {
      snapshotId,
      path: source.path,
      content: source.content,
      blobHash,
      packageKey: packageKeyForPath(projectManifest, source.path)
    };
    const extension = source.path.endsWith(".d.ts") ? ".d.ts" : source.path.slice(source.path.lastIndexOf(".")).toLowerCase();
    const sourceOutputs = [];
    const typedSource = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"].includes(extension);
    const sourceResolutions = resolutions.filter((resolution) => resolution.containingFile === source.path)
      .map(({ specifier, resolvedPath }) => ({ specifier, resolvedPath }));
    if (requestedAnalyzers.has("typescript-core") && typedSource) {
      sourceOutputs.push(analyzeTypeScriptSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("react-core") && [".tsx", ".jsx"].includes(extension)) {
      sourceOutputs.push(analyzeReactSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("react-router-core") && [".tsx", ".jsx", ".ts", ".js"].includes(extension)) {
      sourceOutputs.push(analyzeReactRouterSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("state-data-core") && typedSource) {
      sourceOutputs.push(analyzeStateDataSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("visualization-core") && typedSource) {
      sourceOutputs.push(analyzeVisualizationSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("tooling-test-core") && typedSource) {
      sourceOutputs.push(analyzeToolingTestSource({ ...base, resolutions: sourceResolutions }));
    }
    if (requestedAnalyzers.has("html-core") && extension === ".html") sourceOutputs.push(analyzeHtmlSource(base));
    if (requestedAnalyzers.has("style-core") && [".css", ".scss", ".sass", ".less"].includes(extension)) {
      sourceOutputs.push(analyzeStyleSource(base));
    }
    return sourceOutputs;
    })
  ];
  const registry = new AnalyzerRegistry();
  for (const id of [
    "frontend-project-core",
    "typescript-core",
    "html-core",
    "style-core",
    "react-core",
    "react-router-core",
    "state-data-core",
    "visualization-core",
    "tooling-test-core"
  ]) {
    registry.register({ id, version: "1.0.0", role: "core", facetSchema: z.record(z.string(), z.unknown()) });
  }
  if (outputs.length === 0) {
    return registry.emptyIr(snapshotId);
  }
  const merged = registry.mergeOutputs(outputs);
  if (!merged.valid) {
    throw new Error(`Frontend analyzer outputs conflict: ${merged.lintIssues.map((issue) => `${issue.rule}:${issue.targetId}`).join(", ")}`);
  }
  return merged.ir;
}

function sourcesText(sources: Array<{ path: string; content: string }>, sourcePath: string): string {
  const source = sources.find((candidate) => candidate.path === sourcePath);
  if (!source) throw new Error("TypeScript Program source disappeared during analysis");
  return source.content;
}

if (!isMainThread) {
  const data = workerData as {
    request: unknown;
    maxOutputBytes: number;
    maxOutputNodes: number;
    maxOutputDepth: number;
  };
  const result = analyzeWorkerRequest(data.request);
  let limited = false;
  try {
    assertAnalyzerOutputStructure(result, {
      maxNodes: data.maxOutputNodes,
      maxDepth: data.maxOutputDepth
    });
  } catch {
    limited = true;
  }
  const payload = limited ? null : Buffer.from(JSON.stringify(result), "utf8");
  if (!payload || payload.byteLength > data.maxOutputBytes) {
    parentPort?.postMessage({ type: "error", code: "PARSER_OUTPUT_LIMIT" });
  } else {
    parentPort?.postMessage({ type: "result", payload });
  }
}
