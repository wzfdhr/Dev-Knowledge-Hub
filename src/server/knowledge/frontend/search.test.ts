import { describe, expect, test } from "vitest";

import type { FrontendEdge, FrontendEntity } from "../../../shared/frontend-ir";
import { searchFrontendKnowledge } from "./search";

const ref = { snapshotId: "snapshot", path: "src/dashboard.tsx", startLine: 1, endLine: 20, blobHash: "a".repeat(64) };
const provenance = [{ analyzerId: "react-core", analyzerVersion: "1.0.0", parserConfigDigest: "b".repeat(64), sourceBlobHashes: [ref.blobHash] }];
const page: FrontendEntity = {
  schemaVersion: 2, completeness: "complete", packageKey: "package", provenance,
  id: "1".repeat(64), kind: "component" as const, name: "DashboardPage", qualifiedName: "DashboardPage",
  canonicalPath: "src/dashboard.tsx", identity: { type: "named" as const, semanticKey: "component:DashboardPage" },
  sourceRefs: [ref], facets: {}, attributes: { componentType: { state: "known" as const, value: "function" as const } }
};
const chart: FrontendEntity = {
  ...page, id: "2".repeat(64), name: "DashboardChart", qualifiedName: "DashboardChart",
  identity: { type: "named" as const, semanticKey: "component:DashboardChart" }, canonicalPath: "src/chart.tsx"
};
const edge: FrontendEdge = {
  schemaVersion: 2, provenance,
  id: "3".repeat(64), kind: "renders" as const, fromEntityId: page.id, toEntityId: chart.id,
  evidenceClass: "fact" as const, confidence: 1 as const, sourceRefs: [ref], canonicalEvidenceKey: "dashboard-renders-chart"
};
const moduleEntity: FrontendEntity = {
  ...page, id: "5".repeat(64), kind: "application_entry", name: "src/dashboard.tsx",
  qualifiedName: "src/dashboard.tsx", canonicalPath: "src/dashboard.tsx",
  identity: { type: "named", semanticKey: "module:src/dashboard.tsx" },
  attributes: { runtime: { state: "known", value: "client" } }
};
const exportEdge: FrontendEdge = {
  ...edge, id: "6".repeat(64), kind: "exports", fromEntityId: moduleEntity.id, toEntityId: page.id,
  canonicalEvidenceKey: "dashboard-module-exports-page"
};
const moduleDocument = {
  documentKey: "frontend-architecture:0", kind: "page" as const, title: "Architecture: src/dashboard.tsx",
  content: "application_entry: src/dashboard.tsx typescript module 模块", citations: [ref],
  metadata: { entityId: moduleEntity.id }
};
const document = {
  documentKey: "frontend-components:0", kind: "page" as const, title: "Components and Design",
  content: "component: DashboardPage react component jsx render tree", citations: [ref], metadata: { entityId: page.id }
};
const chartDocument = {
  documentKey: "frontend-components:1", kind: "page" as const, title: "Components and Design",
  content: "component: DashboardChart react component chart", citations: [ref], metadata: { entityId: chart.id }
};
const apiOperation: FrontendEntity = {
  ...page, id: "4".repeat(64), kind: "api_operation", name: "GET /api/teams/:teamId/dashboard",
  qualifiedName: "GET /api/teams/:teamId/dashboard", canonicalPath: "src/api.ts",
  identity: { type: "named", semanticKey: "api:GET:/api/teams/:teamId/dashboard" },
  attributes: {
    method: { state: "known", value: "GET" },
    path: { state: "known", value: "/api/teams/:teamId/dashboard" }
  }
};
const apiDocument = {
  documentKey: "frontend-data:0", kind: "page" as const, title: "Data: GET /api/teams/${teamId}/dashboard",
  content: "api_operation: GET /api/teams/${teamId}/dashboard fetch request api", citations: [ref],
  metadata: { entityId: apiOperation.id }
};

describe("frontend candidate knowledge search", () => {
  test("ranks analyzer entities from real index documents and returns fact evidence", () => {
    const results = searchFrontendKnowledge({
      query: "Where does DashboardPage render its chart?", documents: [document, chartDocument],
      graph: { nodes: [page, chart], edges: [edge] },
      access: { canReadProject: true, visibility: "published", buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" }
    });

    expect(results[0]).toMatchObject({ entityKey: "component:DashboardPage", factKeys: ["renders:component:DashboardPage->component:DashboardChart"] });
    expect(results[0]?.citations).toEqual([ref]);
  });

  test("requires the generated index document content instead of ranking Graph data alone", () => {
    const access = { canReadProject: true, visibility: "published" as const, buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" as const };
    expect(searchFrontendKnowledge({
      query: "DashboardPage", documents: [{ ...document, title: "", content: "" }],
      graph: { nodes: [page, chart], edges: [edge] }, access
    })).toEqual([]);
  });

  test("enforces project, release, and administrator shadow visibility", () => {
    const input = { query: "DashboardPage", documents: [document], graph: { nodes: [page, chart], edges: [edge] } };
    expect(searchFrontendKnowledge({ ...input, access: { canReadProject: false, visibility: "published", buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" } })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, access: { canReadProject: true, visibility: "published", buildId: "candidate", currentReleaseBuildId: "legacy", viewerRole: "admin" } })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, access: { canReadProject: true, visibility: "shadow", buildId: "candidate", currentReleaseBuildId: null, viewerRole: "member" } })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, access: { canReadProject: true, visibility: "shadow", buildId: "candidate", currentReleaseBuildId: null, viewerRole: "admin" } })).toHaveLength(1);
  });

  test("returns no results for an unrelated or empty query", () => {
    const access = { canReadProject: true, visibility: "published" as const, buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" as const };
    expect(searchFrontendKnowledge({ query: "", documents: [document], graph: { nodes: [page, chart], edges: [edge] }, access })).toEqual([]);
    expect(searchFrontendKnowledge({ query: "COBOL payroll batch", documents: [document], graph: { nodes: [page, chart], edges: [edge] }, access })).toEqual([]);
  });

  test("returns no result for unknown frontend subjects instead of matching only category words", () => {
    const access = { canReadProject: true, visibility: "published" as const, buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" as const };
    const input = { documents: [document, chartDocument], graph: { nodes: [page, chart], edges: [edge] }, access };
    expect(searchFrontendKnowledge({ ...input, query: "Where is the PaymentPage React component?" })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, query: "支付页面的 React 组件在哪里？" })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, query: "nonexistent billing checkout" })).toEqual([]);
    expect(searchFrontendKnowledge({ ...input, query: "Locate the /billing/checkout dynamic route and its page" })).toEqual([]);
  });

  test("accepts an indexed parameterized API path while rejecting unknown paths", () => {
    const access = { canReadProject: true, visibility: "published" as const, buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" as const };
    const input = { documents: [apiDocument], graph: { nodes: [apiOperation], edges: [] }, access };

    expect(searchFrontendKnowledge({ ...input, query: "Locate GET /api/teams/:teamId/dashboard API request that loads the dashboard summary" })[0])
      .toMatchObject({ entityKey: "api:GET:/api/teams/:teamId/dashboard" });
    expect(searchFrontendKnowledge({ ...input, query: "Locate GET /api/teams/:otherId/invoices API request" })).toEqual([]);
  });

  test("ranks the exporting TypeScript module ahead of its exported component for module intent", () => {
    const results = searchFrontendKnowledge({
      query: "DashboardPage 对应的 TypeScript 模块在这个项目里如何实现",
      documents: [document, moduleDocument], graph: { nodes: [page, moduleEntity], edges: [exportEdge] },
      access: { canReadProject: true, visibility: "published", buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" }
    });

    expect(results[0]).toMatchObject({
      entityKey: "module:src/dashboard.tsx",
      factKeys: ["exports:module:src/dashboard.tsx->component:DashboardPage"]
    });
  });

  test("indexes Graph adjacency once for a 4,000-entity candidate", () => {
    const nodes: FrontendEntity[] = Array.from({ length: 4_000 }, (_, index) => ({
      ...page,
      id: `node-${index}`,
      name: `Component${index}`,
      qualifiedName: `Component${index}`,
      identity: { type: "named" as const, semanticKey: `component:Component${index}` }
    }));
    const documents = nodes.map((node, index) => ({
      documentKey: `components:${index}`, kind: "page", title: `Components: ${node.name}`,
      content: `component: ${node.name} react component jsx render tree`, citations: [ref],
      metadata: { entityId: node.id }
    }));
    const edges: FrontendEdge[] = nodes.flatMap((node, index) => [1, 2, 3, 4].map((offset) => ({
      ...edge,
      id: `edge-${index}-${offset}`,
      fromEntityId: node.id,
      toEntityId: nodes[(index + offset) % nodes.length]!.id,
      canonicalEvidenceKey: `edge-${index}-${offset}`
    })));
    const startedAt = performance.now();
    const results = searchFrontendKnowledge({
      query: "React component", documents, graph: { nodes, edges },
      access: { canReadProject: true, visibility: "published", buildId: "build", currentReleaseBuildId: "build", viewerRole: "member" }
    });

    expect(results).toHaveLength(5);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  }, 10_000);
});
