import { createHash } from "node:crypto";
import path from "node:path";

import type {
  FrontendEdge,
  FrontendEntity,
  FrontendEntityIdentity,
  FrontendFacetPatch
} from "../../../shared/frontend-ir.js";
import type { SourceRef } from "../../../shared/api-contracts.js";

export interface FrontendAnalyzerSourceInput {
  snapshotId: string;
  path: string;
  content: string;
  blobHash: string;
  packageKey: string;
}

export interface FrontendAnalyzerOutput {
  snapshotId: string;
  analyzerId: string;
  analyzerVersion: string;
  parserConfigDigest: string;
  sourceBlobHashes: string[];
  entities: FrontendEntity[];
  edges: FrontendEdge[];
  facetPatches: FrontendFacetPatch[];
}

export interface FrontendAnalyzer<Input = unknown> {
  readonly id: string;
  readonly version: string;
  analyze(input: Input): Promise<FrontendAnalyzerOutput>;
}

export function frontendAnalyzerConfigDigest(id: string, version: string, parser: string): string {
  return createHash("sha256").update([id, version, parser].join("\0"), "utf8").digest("hex");
}

export function frontendAnalyzerProvenance(
  input: Pick<FrontendAnalyzerSourceInput, "blobHash">,
  analyzerId: string,
  analyzerVersion: string,
  parserConfigDigest: string
) {
  return [{ analyzerId, analyzerVersion, parserConfigDigest, sourceBlobHashes: [input.blobHash] }];
}

export function frontendSourceRef(
  input: FrontendAnalyzerSourceInput,
  startOffset: number,
  endOffset: number
): SourceRef {
  const boundedStart = Math.max(0, Math.min(startOffset, input.content.length));
  const boundedEnd = Math.max(boundedStart, Math.min(endOffset, input.content.length));
  const startLine = input.content.slice(0, boundedStart).split(/\r?\n/).length;
  const endLine = input.content.slice(0, Math.max(boundedStart, boundedEnd - 1)).split(/\r?\n/).length;
  return {
    snapshotId: input.snapshotId,
    path: normalizeFrontendCanonicalPath(input.path),
    startLine,
    endLine,
    blobHash: input.blobHash
  };
}

export function normalizeFrontendCanonicalPath(value: string): string {
  const canonicalPath = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(canonicalPath) || canonicalPath === "." || canonicalPath === ".." || canonicalPath.startsWith("../")) {
    throw new Error("Frontend entity canonicalPath must stay relative");
  }
  return canonicalPath;
}

export function namedFrontendIdentity(semanticKey: string): FrontendEntityIdentity {
  if (!semanticKey.trim()) throw new Error("Named frontend identity requires semanticKey");
  return { type: "named", semanticKey };
}

export function anonymousFrontendIdentity(enclosingSemanticKey: string, astOrdinal: number): FrontendEntityIdentity {
  if (!enclosingSemanticKey.trim() || !Number.isInteger(astOrdinal) || astOrdinal < 0) {
    throw new Error("Anonymous frontend identity requires enclosing semantic key and stable AST ordinal");
  }
  return { type: "anonymous", enclosingSemanticKey, astOrdinal };
}

function identityKey(identity: FrontendEntityIdentity): string {
  return identity.type === "named"
    ? identity.semanticKey
    : `${identity.enclosingSemanticKey}\0anonymous-ast-${identity.astOrdinal}`;
}

export function createFrontendEntityId(input: {
  kind: FrontendEntity["kind"];
  packageKey: string;
  canonicalPath: string;
  identity: FrontendEntityIdentity;
}): string {
  const canonicalPath = normalizeFrontendCanonicalPath(input.canonicalPath);
  const parts = ["frontend-ir-v2", input.kind, input.packageKey, canonicalPath, identityKey(input.identity)];
  if (parts.some((part) => !part.trim())) throw new Error("Frontend entity identity fields must not be empty");
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

export function createFrontendEdgeId(input: Pick<
  FrontendEdge,
  "kind" | "fromEntityId" | "toEntityId" | "canonicalEvidenceKey"
>): string {
  return createHash("sha256")
    .update([input.kind, input.fromEntityId, input.toEntityId, input.canonicalEvidenceKey].join("\0"), "utf8")
    .digest("hex");
}
