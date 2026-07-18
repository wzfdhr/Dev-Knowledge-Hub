import { describe, expect, test } from "vitest";

import { frontendAnalyzerManifestDigest, frontendEdgeSchema, frontendEntitySchema, frontendIrSchema } from "./frontend-ir.js";

const digest = "a".repeat(64);
const sourceRef = { snapshotId: "snapshot-1", path: "src/app.tsx", startLine: 1, endLine: 4, blobHash: digest };
const provenance = {
  analyzerId: "core-typescript", analyzerVersion: "1.0.0",
  parserConfigDigest: digest, sourceBlobHashes: [digest]
};
const component = () => frontendEntitySchema.parse({
  schemaVersion: 2, id: digest, kind: "component", name: "DashboardPage", qualifiedName: "app.DashboardPage",
  completeness: "partial", packageKey: "app", canonicalPath: "src/app.tsx",
  identity: { type: "named", semanticKey: "DashboardPage" },
  attributes: { componentType: { state: "unknown", reason: "unsupported_version" } },
  facets: {}, sourceRefs: [sourceRef], provenance: [provenance]
});

describe("Frontend IR v2 contract", () => {
  test("parses approved entity kinds and typed unsupported-version values", () => {
    const entity = component();
    expect(entity.kind).toBe("component");
    if (entity.kind === "component") {
      expect(entity.attributes.componentType).toEqual({ state: "unknown", reason: "unsupported_version" });
    }
    expect(() => frontendEntitySchema.parse({
      ...entity,
      completeness: "complete",
      attributes: { componentType: { state: "unknown", reason: "unresolved" } }
    })).toThrow("complete frontend entity cannot contain unknown");
  });

  test("requires citations for facts and evidence keys for bounded candidates", () => {
    expect(() => frontendEdgeSchema.parse({
      schemaVersion: 2, id: digest, kind: "renders", fromEntityId: digest, toEntityId: "b".repeat(64),
      canonicalEvidenceKey: "jsx:1", evidenceClass: "fact", confidence: 1, sourceRefs: [], provenance: [provenance]
    })).toThrow();
    expect(() => frontendEdgeSchema.parse({
      schemaVersion: 2, id: digest, kind: "renders", fromEntityId: digest, toEntityId: "b".repeat(64),
      canonicalEvidenceKey: "heuristic:1", evidenceClass: "candidate", confidence: 0.5, sourceRefs: [], provenance: [provenance]
    })).toThrow();
  });

  test("rejects duplicate ids, cross-snapshot references, and missing endpoints", () => {
    const entity = component();
    const analyzerManifest = [{ analyzerId: "core-typescript", analyzerVersion: "1.0.0", parserConfigDigest: digest, sourceBlobHashes: [digest] }];
    const base = {
      schemaVersion: 2, snapshotId: "snapshot-1",
      analyzerManifestDigest: frontendAnalyzerManifestDigest(analyzerManifest), analyzerManifest
    };
    expect(() => frontendIrSchema.parse({ ...base, entities: [entity, entity], edges: [] })).toThrow("duplicate entity id");
    expect(() => frontendIrSchema.parse({ ...base, snapshotId: "other", entities: [entity], edges: [] })).toThrow("same snapshot");
    expect(() => frontendIrSchema.parse({
      ...base, entities: [entity], edges: [{
        schemaVersion: 2, id: "b".repeat(64), kind: "imports", fromEntityId: digest, toEntityId: "c".repeat(64),
        canonicalEvidenceKey: "import:1", evidenceClass: "fact", confidence: 1,
        sourceRefs: [sourceRef], provenance: [provenance]
      }]
    })).toThrow("missing endpoint");
    expect(() => frontendIrSchema.parse({
      ...base, analyzerManifestDigest: "f".repeat(64), entities: [entity], edges: []
    })).toThrow("manifest digest does not match");
  });
});
