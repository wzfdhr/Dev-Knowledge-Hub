import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { buildFrontendGraph } from "./graph-builder.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";
import { analyzeWorkerRequest } from "./runtime/analyzer-worker.js";

const ref = { snapshotId: "snapshot", path: "src/app.tsx", startLine: 1, endLine: 4, blobHash: "1".repeat(64) };
const provenance = [{ analyzerId: "react-core", analyzerVersion: "1.0.0", parserConfigDigest: "2".repeat(64), sourceBlobHashes: [ref.blobHash] }];

function entity(id: string, kind: string, name: string, canonicalPath = ref.path) {
  return { id, kind, name, qualifiedName: `${canonicalPath}#${name}`, canonicalPath, packageKey: "app", sourceRefs: [{ ...ref, path: canonicalPath }], provenance, facets: {} };
}

describe("buildFrontendGraph", () => {
  test("links router pages to exact components and keeps inferred style proximity as candidate", () => {
    const ir = {
      schemaVersion: 2,
      snapshotId: "snapshot",
      analyzerManifestDigest: "3".repeat(64),
      analyzerManifest: provenance,
      entities: [
        entity("route", "route", "/", "src/router.tsx"),
        entity("page", "page", "DashboardPage"),
        entity("component", "component", "DashboardPage"),
        entity("style", "style_scope", ".dashboard", "src/styles.module.css")
      ],
      edges: [{ id: "route-page", kind: "routes_to", fromEntityId: "route", toEntityId: "page", evidenceClass: "fact", confidence: 1, canonicalEvidenceKey: "route", sourceRefs: [ref], provenance }]
    } as unknown as FrontendIR;
    const graph = buildFrontendGraph(ir);

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "renders", fromEntityId: "page", toEntityId: "component", evidenceClass: "fact", confidence: 1 }),
      expect.objectContaining({ kind: "styles", fromEntityId: "component", toEntityId: "style", evidenceClass: "candidate", candidateReason: "package_style_proximity" })
    ]));
  });

  test("preserves the directed React application flow from page to frontend concerns", () => {
    const fixtureRoot = "fixtures/frontend/react-vite";
    const paths = [
      "package.json", "tsconfig.json", "vite.config.ts", "src/api.ts", "src/app.tsx",
      "src/app.test.tsx", "src/chart.tsx", "src/main.tsx", "src/router.tsx", "src/store.ts",
      "e2e/app.spec.ts"
    ];
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-react-graph",
      analyzerIds: [
        "frontend-project", "typescript-core", "react-core", "react-router-core",
        "state-data-core", "visualization-core", "tooling-test-core"
      ],
      cachedAnalyses: [],
      sources: paths.map((sourcePath) => {
        const content = readFileSync(`${fixtureRoot}/${sourcePath}`);
        return {
          path: sourcePath,
          contentBase64: content.toString("base64"),
          blobHash: createHash("sha256").update(content).digest("hex")
        };
      })
    });
    const graph = buildFrontendGraph(result.outputs[0]!.frontendIr!);
    const entity = (kind: string, name: string) => graph.nodes.find((node) => node.kind === kind && node.name === name)!.id;
    const fact = (kind: string, from: string, to: string) => expect(graph.edges).toContainEqual(expect.objectContaining({
      kind, fromEntityId: from, toEntityId: to, evidenceClass: "fact"
    }));
    const page = entity("page", "DashboardPage");
    const component = entity("component", "DashboardPage");

    fact("routes_to", entity("route", "/"), page);
    fact("renders", page, component);
    fact("reads_state", component, entity("state_store", "useDashboardStore"));
    fact("requests", component, entity("symbol", "loadDashboard"));
    fact("renders", component, entity("component", "DashboardChart"));
    fact("visualizes", entity("component", "DashboardChart"), entity("visualization", "chart"));
    fact("tests", entity("test_case", "renders the dashboard heading"), component);
  });
});
