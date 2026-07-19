import { describe, expect, test } from "vitest";

import { ApiError } from "../../api/client";
import type { FrontendPreviewResponse } from "../../api/types";
import { frontendPreviewErrorState, frontendPreviewState } from "./frontend-preview-state";

function ready(overrides: Partial<Extract<FrontendPreviewResponse, { status: "ready" }>> = {}): Extract<FrontendPreviewResponse, { status: "ready" }> {
  return {
    status: "ready", stale: false,
    comparison: { legacy: { entities: 0, factRelations: 0, pages: 0, searchDocuments: 0, impactPaths: 0, issues: 0 }, candidate: { entities: 1, factRelations: 0, candidateRelations: 0, pages: 1, searchDocuments: 1, impactPaths: 0, issues: 0 }, candidateEntityKeys: [], candidateFactKeys: [], impact: { legacyPaths: [], candidatePaths: [], legacySuggestedTests: [], candidateSuggestedTests: [] }, citations: { valid: true, checked: 1, invalid: [] } },
    preview: { build: { id: "build", snapshotId: "snapshot", commitSha: "a".repeat(40), status: "ready" }, graph: { schemaVersion: 2, snapshotId: "snapshot", analyzerManifestDigest: "1".repeat(64), nodes: [{ id: "app", kind: "application_entry", name: "App", qualifiedName: "src/app.tsx#App", canonicalPath: "src/app.tsx", packageKey: "app", sourceRefs: [], facets: {}, attributes: {} }], edges: [] }, pages: [], search: [], quality: { summary: { entities: 1, factEdges: 0, candidateEdges: 0, citedEntities: 0, components: 0, testedComponents: 0, routes: 0, visualizations: 0 }, issues: [] }, visualization: { routeIds: [], componentIds: [], visualizationIds: [], factEdgeIds: [] }, validation: { valid: true, pageCount: 1, issueCount: 0 } },
    ...overrides
  };
}

describe("frontend preview product states", () => {
  test.each([
    [{ status: "source_missing", preview: null }, "source_missing"],
    [{ status: "build_missing", preview: null }, "build_missing"],
    [{ status: "build_failed", preview: null, build: { id: "build", status: "failed" } }, "build_failed"],
    [{ status: "candidate_failed", preview: null, build: { id: "build", status: "ready" }, failedStage: { stage: "extract", errorCode: "PARSER_RUNTIME_UNAVAILABLE" } }, "candidate_failed"],
    [{ status: "candidate_pending", preview: null, build: { id: "build", status: "running" } }, "candidate_pending"]
  ] as const)("maps %o to %s with recovery guidance", (response, code) => {
    const result = frontendPreviewState(response as FrontendPreviewResponse);
    expect(result).toMatchObject({ code });
    expect(result.safety).toBeTruthy();
    expect(result.next).toBeTruthy();
    expect(result.retry).toBeTruthy();
  });

  test("prioritizes invalid citations, empty graph, and stale snapshots", () => {
    expect(frontendPreviewState(ready({ comparison: { ...ready().comparison, citations: { valid: false, checked: 1, invalid: ["src/app.tsx:0-0"] } } })).code).toBe("citation_invalid");
    expect(frontendPreviewState(ready({ preview: { ...ready().preview, graph: { ...ready().preview.graph, nodes: [] } } })).code).toBe("graph_empty");
    expect(frontendPreviewState(ready({ stale: true })).code).toBe("snapshot_updated");
    expect(frontendPreviewState(ready()).code).toBe("candidate_unpublished");
  });

  test("distinguishes permission loss from network failure", () => {
    expect(frontendPreviewErrorState(new ApiError(403, "FORBIDDEN", "Forbidden")).code).toBe("permission_lost");
    expect(frontendPreviewErrorState(new TypeError("fetch failed")).code).toBe("network_failure");
  });
});
