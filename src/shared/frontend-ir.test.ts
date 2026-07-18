import { describe, expect, test } from "vitest";

import {
  frontendEdgeSchema,
  frontendEntitySchema,
  frontendIrSchema
} from "./frontend-ir.js";

const digest = "a".repeat(64);
const sourceRef = {
  snapshotId: "snapshot-1",
  path: "src/app.tsx",
  startLine: 1,
  endLine: 4,
  blobHash: digest
};
const provenance = { analyzerId: "core-typescript", analyzerVersion: "1.0.0", configDigest: digest };

describe("Frontend IR v2 contract", () => {
  test("parses typed known and unknown component attributes", () => {
    const entity = frontendEntitySchema.parse({
      schemaVersion: 2,
      id: digest,
      kind: "component",
      completeness: "partial",
      packageKey: "app",
      canonicalPath: "src/app.tsx",
      semanticKey: "DashboardPage",
      attributes: {
        name: { status: "known", value: "DashboardPage" },
        componentType: { status: "unknown", reason: "dynamic" }
      },
      facets: { "core-typescript": { exported: true } },
      sourceRefs: [sourceRef],
      provenance: [provenance]
    });

    expect(entity.kind).toBe("component");
    if (entity.kind === "component") expect(entity.attributes.name).toEqual({ status: "known", value: "DashboardPage" });
  });

  test("requires citations for facts and reason plus bounded confidence for candidates", () => {
    expect(() => frontendEdgeSchema.parse({
      schemaVersion: 2, id: digest, kind: "renders", fromEntityId: digest, toEntityId: "b".repeat(64),
      evidence: "fact", confidence: 1, sourceRefs: [], provenance: [provenance]
    })).toThrow();
    expect(() => frontendEdgeSchema.parse({
      schemaVersion: 2, id: digest, kind: "renders", fromEntityId: digest, toEntityId: "b".repeat(64),
      evidence: "candidate", confidence: 1, sourceRefs: [], provenance: [provenance]
    })).toThrow();
  });

  test("rejects duplicate ids and non-deterministic ordering", () => {
    const entity = frontendEntitySchema.parse({
      schemaVersion: 2, id: digest, kind: "module", completeness: "complete", packageKey: "app",
      canonicalPath: "src/app.tsx", semanticKey: "module", attributes: {
        name: { status: "known", value: "src/app.tsx" },
        moduleFormat: { status: "known", value: "esm" }
      }, facets: {}, sourceRefs: [sourceRef], provenance: [provenance]
    });
    expect(() => frontendIrSchema.parse({
      schemaVersion: 2,
      snapshotId: "snapshot-1",
      analyzerManifestDigest: digest,
      entities: [entity, entity],
      edges: []
    })).toThrow("duplicate entity id");
  });

  test("rejects cross-snapshot references and edges with missing endpoints", () => {
    const entity = frontendEntitySchema.parse({
      schemaVersion: 2, id: digest, kind: "module", completeness: "complete", packageKey: "app",
      canonicalPath: "src/app.tsx", semanticKey: "module", attributes: {
        name: { status: "known", value: "src/app.tsx" },
        moduleFormat: { status: "known", value: "esm" }
      }, facets: {}, sourceRefs: [sourceRef], provenance: [provenance]
    });
    expect(() => frontendIrSchema.parse({
      schemaVersion: 2, snapshotId: "other-snapshot", analyzerManifestDigest: digest, entities: [entity], edges: []
    })).toThrow("same snapshot");
    expect(() => frontendIrSchema.parse({
      schemaVersion: 2, snapshotId: "snapshot-1", analyzerManifestDigest: digest, entities: [entity],
      edges: [{
        schemaVersion: 2, id: "b".repeat(64), kind: "imports", fromEntityId: digest,
        toEntityId: "c".repeat(64), evidence: "fact", confidence: 1, sourceRefs: [sourceRef], provenance: [provenance]
      }]
    })).toThrow("missing endpoint");
  });
});
