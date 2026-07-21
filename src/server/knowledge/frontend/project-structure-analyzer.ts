import path from "node:path";

import type { FrontendEntity } from "../../../shared/frontend-ir.js";
import {
  createFrontendEntityId,
  frontendAnalyzerConfigDigest,
  frontendAnalyzerProvenance,
  frontendSourceRef,
  namedFrontendIdentity,
  type FrontendAnalyzerOutput
} from "./analyzer.js";

const ANALYZER_ID = "frontend-project-core";
const ANALYZER_VERSION = "1.0.0";
const CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, "package-tsconfig-v1");

interface ProjectSource { path: string; content: string; blobHash: string }

function entity(source: ProjectSource, snapshotId: string, value: {
  kind: "workspace_package" | "tooling_config"; name: string; packageKey: string;
  attributes: FrontendEntity["attributes"]; facets: Record<string, unknown>; completeness: "complete" | "partial";
}): FrontendEntity {
  const identity = namedFrontendIdentity(`${value.kind}:${value.name}`);
  const input = { ...source, snapshotId, packageKey: value.packageKey };
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: value.kind, packageKey: value.packageKey, canonicalPath: source.path, identity }),
    kind: value.kind,
    name: value.name,
    qualifiedName: `${source.path}#${value.name}`,
    completeness: value.completeness,
    packageKey: value.packageKey,
    canonicalPath: source.path,
    identity,
    facets: { [ANALYZER_ID]: value.facets },
    attributes: value.attributes,
    sourceRefs: [frontendSourceRef(input, 0, source.content.length)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, CONFIG_DIGEST)
  } as FrontendEntity;
}

export function analyzeProjectStructure(input: { snapshotId: string; sources: ProjectSource[] }): FrontendAnalyzerOutput[] {
  return input.sources.flatMap((source) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(source.content) as Record<string, unknown>; } catch { return []; }
    let value: FrontendEntity | null = null;
    if (path.posix.basename(source.path) === "package.json") {
      const name = typeof parsed.name === "string" ? parsed.name : path.posix.dirname(source.path) || "workspace";
      const version = typeof parsed.version === "string" ? parsed.version : null;
      const managerName = typeof parsed.packageManager === "string" ? parsed.packageManager.split("@")[0] : null;
      const manager = managerName === "npm" || managerName === "pnpm" || managerName === "yarn" || managerName === "bun"
        ? managerName : null;
      value = entity(source, input.snapshotId, {
        kind: "workspace_package", name, packageKey: name, completeness: version && manager ? "complete" : "partial",
        facets: { scripts: parsed.scripts ?? {}, dependencies: parsed.dependencies ?? {} },
        attributes: {
          packageManager: manager ? { state: "known", value: manager } : { state: "unknown", reason: "unresolved" },
          version: version ? { state: "known", value: version } : { state: "unknown", reason: "unresolved" }
        }
      });
    } else if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(path.posix.basename(source.path))) {
      value = entity(source, input.snapshotId, {
        kind: "tooling_config", name: "tsconfig", packageKey: "workspace", completeness: "complete",
        facets: { paths: (parsed.compilerOptions as Record<string, unknown> | undefined)?.paths ?? {}, references: parsed.references ?? [] },
        attributes: { tool: { state: "known", value: "typescript" } }
      });
    }
    if (!value) return [];
    return [{
      snapshotId: input.snapshotId, analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION,
      parserConfigDigest: CONFIG_DIGEST, sourceBlobHashes: [source.blobHash], entities: [value], edges: [], facetPatches: []
    }];
  });
}
