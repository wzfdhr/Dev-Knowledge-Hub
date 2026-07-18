import { createHash } from "node:crypto";
import path from "node:path";

import type { FrontendEdge, FrontendEntity } from "../../../shared/frontend-ir.js";

export interface FrontendAnalyzerOutput {
  analyzerId: string;
  analyzerVersion: string;
  entities: FrontendEntity[];
  edges: FrontendEdge[];
}

export interface FrontendAnalyzer<Input = unknown> {
  readonly id: string;
  readonly version: string;
  analyze(input: Input): Promise<FrontendAnalyzerOutput>;
}

export function normalizeFrontendCanonicalPath(value: string): string {
  const canonicalPath = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(canonicalPath) || canonicalPath === "." || canonicalPath === ".." || canonicalPath.startsWith("../")) {
    throw new Error("Frontend entity canonicalPath must stay relative");
  }
  return canonicalPath;
}

export function createFrontendEntityId(input: {
  kind: string;
  packageKey: string;
  canonicalPath: string;
  semanticKey: string;
}): string {
  const canonicalPath = normalizeFrontendCanonicalPath(input.canonicalPath);
  const parts = ["frontend-ir-v2", input.kind, input.packageKey, canonicalPath, input.semanticKey];
  if (parts.some((part) => !part.trim())) throw new Error("Frontend entity identity fields must not be empty");
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

export function createFrontendEdgeId(input: {
  kind: string;
  fromEntityId: string;
  toEntityId: string;
}): string {
  return createHash("sha256")
    .update(["frontend-graph-v2", input.kind, input.fromEntityId, input.toEntityId].join("\0"), "utf8")
    .digest("hex");
}
