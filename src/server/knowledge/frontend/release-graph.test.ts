import { expect, test } from "vitest";

import { loadPublishedFrontendGraph } from "./release-graph.js";

const hash = "a".repeat(64);
const release = {
  id: "release", workspaceId: "workspace", repositoryId: "repository", buildId: "build", snapshotId: "snapshot",
  version: "1.0.0", kernelMode: "pipeline", packageArtifactId: "package", releaseArtifactFamily: "frontend-v2",
  packageStageRunId: "package-run", frontendIrSchemaVersion: 2, frontendGraphSchemaVersion: 2,
  analyzerManifestDigest: hash, createdAt: new Date(), publishedAt: new Date()
} as const;

test("loads the graph referenced by a published frontend-v2 package", async () => {
  const artifact = (id: string, stage: "package" | "graph", kind: string) => ({
    id, workspaceId: "workspace", projectId: "project", snapshotId: "snapshot", buildId: "build", stage,
    kind, schemaVersion: 2, inputDigest: hash, contentDigest: hash, storageKey: id, sourceRefs: [], producer: "deterministic" as const, createdAt: "2026-07-24"
  });
  const packageValue = {
    schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId: "snapshot", analyzerManifestDigest: hash,
    upstreamManifestIds: ["legacy-validation", "validation"], sourceArtifactId: "legacy-package", irSchemaVersion: 2, graphSchemaVersion: 2,
    artifacts: { convert: ["legacy-convert"], extract: ["legacy-extract", "frontend-extract"], tables: ["legacy-tables", "frontend-tables"], graph: ["legacy-graph", "graph"], synthesize: ["legacy-pages", "pages"], index: ["legacy-index", "search"], lint: ["legacy-quality", "quality"], viz: ["legacy-viz", "viz"], validate: ["legacy-validation", "validation"], package: ["legacy-package"] }
  };
  const graph = { schemaVersion: 2, snapshotId: "snapshot", analyzerManifestDigest: hash, nodes: [], edges: [] };
  const result = await loadPublishedFrontendGraph({
    release: release as never, workspaceId: "workspace", projectId: "project",
    store: { findArtifactById: async (id: string) => id === "package" ? artifact(id, "package", "frontend-pipeline-package") : id === "graph" ? artifact(id, "graph", "frontend-graph-v2") : null },
    reader: { getJson: async (item: { id: string }) => item.id === "package" ? packageValue : graph }
  });

  expect(result).toEqual(graph);
});
