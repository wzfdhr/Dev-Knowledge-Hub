import { describe, expect, test, vi } from "vitest";

import { loadFrontendCandidatePreview, FrontendPreviewUnavailableError } from "./preview.js";
import type { ArtifactManifest } from "../../../shared/api-contracts.js";

const workspaceId = "workspace";
const projectId = "project";
const snapshotId = "snapshot";
const buildId = "build";
const hash = "1".repeat(64);

function manifest(id: string, stage: ArtifactManifest["stage"], kind: string): ArtifactManifest {
  return {
    id, workspaceId, projectId, snapshotId, buildId, stage, kind, schemaVersion: 2,
    inputDigest: hash, contentDigest: hash, storageKey: `${id}.json`, sourceRefs: [],
    producer: "deterministic", createdAt: "2026-07-19T00:00:00.000Z"
  };
}

function fixture() {
  const manifests = [
    manifest("graph", "graph", "frontend-graph-v2"),
    manifest("pages", "synthesize", "frontend-knowledge-pages-v2"),
    manifest("search", "index", "frontend-search-index-v2"),
    manifest("quality", "lint", "frontend-knowledge-quality-v2"),
    manifest("viz", "viz", "frontend-visualization-v2"),
    manifest("validation", "validate", "frontend-validation-v2"),
    manifest("package", "package", "frontend-pipeline-package")
  ];
  const ref = { snapshotId, path: "src/app.tsx", startLine: 1, endLine: 2, blobHash: hash };
  const values = new Map<string, unknown>([
    ["graph", { schemaVersion: 2, snapshotId, analyzerManifestDigest: hash, nodes: [], edges: [] }],
    ["pages", { schemaVersion: 2, snapshotId, pages: [{ id: hash, slug: "frontend-routes", title: "Routes and Pages", kind: "routes", items: [], citations: [ref], chunks: [{ heading: "Routes", content: "route: /", citations: [ref] }] }] }],
    ["search", { schemaVersion: 2, snapshotId, analyzerManifestDigest: hash, documents: [{ documentKey: "frontend-routes:0", kind: "page", title: "Routes and Pages", content: "route: /", citations: [ref], metadata: { pageSlug: "frontend-routes", position: 0 } }] }],
    ["quality", { schemaVersion: 2, snapshotId, analyzerManifestDigest: hash, summary: { entities: 1, factEdges: 0, candidateEdges: 0, citedEntities: 1, components: 0, testedComponents: 0, routes: 1, visualizations: 0 }, issues: [] }],
    ["viz", { schemaVersion: 2, snapshotId, analyzerManifestDigest: hash, routeIds: [], componentIds: [], visualizationIds: [], factEdgeIds: [] }],
    ["validation", { schemaVersion: 2, family: "frontend-v2", stage: "validate", snapshotId, analyzerManifestDigest: hash, upstreamManifestIds: [], sourceArtifactId: "legacy-validation", valid: true, pageCount: 1, issueCount: 0, graphReferenceCount: 2, checkedReferenceCount: 5, invalidReferenceCount: 0 }],
    ["package", { schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId, analyzerManifestDigest: hash, upstreamManifestIds: ["legacy-validation", "validation"], sourceArtifactId: "legacy-package", irSchemaVersion: 2, graphSchemaVersion: 2, artifacts: { convert: ["legacy-convert"], extract: ["legacy-extract", "frontend-extract"], tables: ["legacy-tables", "frontend-tables"], graph: ["legacy-graph", "graph"], synthesize: ["legacy-pages", "pages"], index: ["legacy-index", "search"], lint: ["legacy-quality", "quality"], viz: ["legacy-viz", "viz"], validate: ["legacy-validation", "validation"], package: ["legacy-package"] } }]
  ]);
  const store = {
    getBuild: vi.fn(async () => ({ id: buildId, workspaceId, repositoryId: "repository", snapshotId, commitSha: "a".repeat(40), status: "ready" })),
    getRepository: vi.fn(async () => ({ id: "repository", workspaceId, projectId })),
    listPipelineStageRuns: vi.fn(async () => [
      ...[["graph", "graph"], ["synthesize", "pages"], ["index", "search"], ["lint", "quality"], ["viz", "viz"], ["validate", "validation"]].map(([stage, output]) => ({
        id: `${stage}-run`, workspaceId, projectId, snapshotId, buildId, stage, attempt: 1, status: "succeeded",
        inputDigest: hash, outputManifestIds: [`legacy-${output}`, output], startedAt: null, finishedAt: null,
        errorCode: null, errorDetail: null
      })),
      { id: "package-run", workspaceId, projectId, snapshotId, buildId, stage: "package", attempt: 1, status: "succeeded", inputDigest: hash, outputManifestIds: ["legacy-package", "package"], startedAt: null, finishedAt: null, errorCode: null, errorDetail: null }
    ]),
    findArtifactById: vi.fn(async (id: string) => manifests.find((item) => item.id === id) ?? manifest(id, "convert", `legacy-${id}`))
  };
  return { store, reader: { getJson: vi.fn(async (item: ArtifactManifest) => values.get(item.id)) }, manifests, values };
}

describe("loadFrontendCandidatePreview", () => {
  test("loads only the complete terminal frontend package for the requested project build", async () => {
    const { store, reader } = fixture();
    const result = await loadFrontendCandidatePreview({ store: store as never, reader, workspaceId, projectId, buildId });

    expect(result.build).toMatchObject({ id: buildId, snapshotId });
    expect(result.pages[0]).toMatchObject({ slug: "frontend-routes" });
    expect(result.search[0]).toMatchObject({ documentKey: "frontend-routes:0" });
    expect(result.validation).toMatchObject({ valid: true, pageCount: 1 });
  });

  test("rejects a frontend artifact that crosses the package scope", async () => {
    const { store, reader, manifests } = fixture();
    manifests.find((item) => item.id === "graph")!.projectId = "other-project";

    await expect(loadFrontendCandidatePreview({ store: store as never, reader, workspaceId, projectId, buildId }))
      .rejects.toBeInstanceOf(FrontendPreviewUnavailableError);
  });

  test("rejects a packaged candidate whose validation is false", async () => {
    const { store, reader, values } = fixture();
    values.set("validation", {
      schemaVersion: 2, family: "frontend-v2", stage: "validate", snapshotId,
      analyzerManifestDigest: hash, valid: false, pageCount: 1, issueCount: 0,
      upstreamManifestIds: [], sourceArtifactId: "legacy-validation",
      graphReferenceCount: 2, checkedReferenceCount: 5, invalidReferenceCount: 1
    });

    await expect(loadFrontendCandidatePreview({ store: store as never, reader, workspaceId, projectId, buildId }))
      .rejects.toThrow("validation failed");
  });

  test("rejects historical valid artifacts without complete Graph reference evidence", async () => {
    const { store, reader, values } = fixture();
    values.set("validation", {
      schemaVersion: 2, family: "frontend-v2", stage: "validate", snapshotId,
      analyzerManifestDigest: hash, valid: true, pageCount: 1, issueCount: 0
    });

    await expect(loadFrontendCandidatePreview({ store: store as never, reader, workspaceId, projectId, buildId }))
      .rejects.toBeDefined();
  });
});
