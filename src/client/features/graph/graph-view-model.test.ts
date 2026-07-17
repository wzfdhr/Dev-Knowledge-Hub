import { describe, expect, expectTypeOf, test } from "vitest";

import type { ApiClient } from "../../api/client";
import type { KnowledgeGraph, KnowledgeGraphNode, ProjectGraphResponse } from "../../api/types";
import { describeGraphReduction, filterGraph, layoutGraph } from "./graph-view-model";

export function jsonNodesFromGraphResponse(response: ProjectGraphResponse<"json" | "tree">) {
  if (response.format !== "json" || response.data === null) return [];
  return response.data.nodes;
}

export function assertProjectGraphClientContract(client: ApiClient) {
  expectTypeOf(client.getProjectGraph("project")).toEqualTypeOf<Promise<ProjectGraphResponse<"tree">>>();
  expectTypeOf(client.getProjectGraph("project", "json")).toEqualTypeOf<Promise<ProjectGraphResponse<"json">>>();
  expectTypeOf(client.getProjectGraph("project", "tree")).toEqualTypeOf<Promise<ProjectGraphResponse<"tree">>>();
  expectTypeOf(client.getProjectGraph("project", "mermaid")).toEqualTypeOf<Promise<ProjectGraphResponse<"mermaid">>>();
  expectTypeOf(client.getProjectGraph("project", "markmap")).toEqualTypeOf<Promise<ProjectGraphResponse<"markmap">>>();
}

function graph(overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    nodes: [
      { id: "module-api", projectId: "project", snapshotId: "snapshot", kind: "module", name: "API", qualifiedName: "src/api.ts", candidate: false, sourceRefs: [], attributes: {} },
      { id: "module-web", projectId: "project", snapshotId: "snapshot", kind: "module", name: "Web", qualifiedName: "src/web.ts", candidate: false, sourceRefs: [], attributes: {} },
      { id: "symbol-client", projectId: "project", snapshotId: "snapshot", kind: "symbol", name: "Client", qualifiedName: "src/api.ts.Client", candidate: false, sourceRefs: [], attributes: {} },
      { id: "document-readme", projectId: "project", snapshotId: "snapshot", kind: "document", name: "README", qualifiedName: "README.md", candidate: false, sourceRefs: [], attributes: {} }
    ],
    edges: [
      { id: "contains-client", fromNodeId: "module-api", toNodeId: "symbol-client", kind: "contains", candidate: false, confidence: 1, sourceRefs: [] },
      { id: "imports-web", fromNodeId: "module-web", toNodeId: "module-api", kind: "imports", candidate: false, confidence: 1, sourceRefs: [] },
      { id: "candidate-document", fromNodeId: "document-readme", toNodeId: "module-api", kind: "documents", candidate: true, candidateReason: "heuristic", confidence: 0.5, sourceRefs: [] },
      { id: "dangling", fromNodeId: "module-api", toNodeId: "gone", kind: "imports", candidate: false, confidence: 1, sourceRefs: [] }
    ],
    ...overrides
  };
}

describe("knowledge graph view model", () => {
  test("orders modules before other matching graph nodes", () => {
    const result = filterGraph({ graph: graph(), query: "", enabledKinds: new Set(["module", "symbol", "document"]), includeCandidates: false });

    expect(result.nodes.map((node) => node.id)).toEqual(["module-api", "module-web", "document-readme", "symbol-client"]);
  });

  test("matches graph nodes by name and qualified path without case sensitivity", () => {
    const result = filterGraph({ graph: graph(), query: "SRC/API", enabledKinds: new Set(["module", "symbol", "document"]), includeCandidates: false });

    expect(result.nodes.map((node) => node.id)).toEqual(["module-api", "symbol-client", "module-web", "document-readme"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["contains-client", "imports-web"]);
  });

  test("returns no visible nodes when an active search has no matches", () => {
    const result = filterGraph({ graph: graph(), query: "does-not-exist", enabledKinds: new Set(["module", "symbol", "document"]), includeCandidates: false });

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.omittedNodeCount).toBe(0);
  });

  test("keeps candidate nodes eligible while toggling candidate edge visibility", () => {
    const base = graph({ nodes: [...graph().nodes, { id: "candidate-command", projectId: "project", snapshotId: "snapshot", kind: "command", name: "Start", qualifiedName: "npm start", candidate: true, sourceRefs: [], attributes: {} }] });
    const hidden = filterGraph({ graph: base, query: "", enabledKinds: new Set(["module", "symbol", "document", "command"]), includeCandidates: false });
    const shown = filterGraph({ graph: base, query: "", enabledKinds: new Set(["module", "symbol", "document", "command"]), includeCandidates: true });

    expect(hidden.nodes.map((node) => node.id)).toContain("candidate-command");
    expect(hidden.edges.map((edge) => edge.id)).not.toContain("candidate-document");
    expect(shown.nodes.map((node) => node.id)).toContain("candidate-command");
    expect(shown.edges.map((edge) => edge.id)).toContain("candidate-document");
  });

  test("prioritizes matches, then fact-edge context, before deterministic fill at the node cap", () => {
    const matchingNode = { id: "symbol-match", projectId: "project", snapshotId: "snapshot", kind: "symbol" as const, name: "Needle", qualifiedName: "src/needle.ts", candidate: false, sourceRefs: [], attributes: {} };
    const contextNodes = Array.from({ length: 160 }, (_, index) => ({
      id: `document-context-${String(index).padStart(3, "0")}`,
      projectId: "project", snapshotId: "snapshot", kind: "document" as const,
      name: `Context ${String(index).padStart(3, "0")}`, qualifiedName: `context/${index}.md`, candidate: false, sourceRefs: [], attributes: {}
    }));
    const result = filterGraph({
      graph: graph({
        nodes: [matchingNode, ...contextNodes, { id: "module-fill", projectId: "project", snapshotId: "snapshot", kind: "module", name: "A Fill", qualifiedName: "fill.ts", candidate: false, sourceRefs: [], attributes: {} }],
        edges: contextNodes.map((node) => ({ id: `fact-${node.id}`, fromNodeId: matchingNode.id, toNodeId: node.id, kind: "documents" as const, candidate: false as const, confidence: 1, sourceRefs: [] }))
      }),
      query: "needle",
      enabledKinds: new Set(["module", "symbol", "document"]),
      includeCandidates: false
    });

    expect(result.nodes).toHaveLength(160);
    expect(result.nodes.map((node) => node.id)).toContain("symbol-match");
    expect(result.nodes.map((node) => node.id)).toContain("document-context-158");
    expect(result.nodes.map((node) => node.id)).not.toContain("document-context-159");
    expect(result.nodes.map((node) => node.id)).not.toContain("module-fill");
  });

  test("removes every edge whose endpoint is not visible", () => {
    const result = filterGraph({ graph: graph(), query: "", enabledKinds: new Set(["module"]), includeCandidates: false });

    expect(result.nodes.map((node) => node.id)).toEqual(["module-api", "module-web"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["imports-web"]);
  });

  test("limits large graphs and explains the omitted count", () => {
    const large = graph({
      nodes: Array.from({ length: 161 }, (_, index) => ({
        id: `module-${String(index).padStart(3, "0")}`,
        projectId: "project", snapshotId: "snapshot", kind: "module" as const,
        name: `Module ${index}`, qualifiedName: `src/${index}.ts`, candidate: false, sourceRefs: [], attributes: {}
      })),
      edges: []
    });
    const result = filterGraph({ graph: large, query: "", enabledKinds: new Set(["module"]), includeCandidates: false });

    expect(result.nodes).toHaveLength(160);
    expect(result.omittedNodeCount).toBe(1);
    expect(describeGraphReduction(result)).toContain("160");
    expect(describeGraphReduction(result)).toContain("1");
  });

  test("creates the same module-first layout for the same graph", () => {
    const visible = filterGraph({ graph: graph(), query: "", enabledKinds: new Set(["module", "symbol", "document"]), includeCandidates: false });
    const reversed = graph({ nodes: [...graph().nodes].reverse(), edges: [...graph().edges].reverse() });
    const reversedVisible = filterGraph({ graph: reversed, query: "", enabledKinds: new Set(["module", "symbol", "document"]), includeCandidates: false });

    expect(layoutGraph(visible)).toEqual(layoutGraph(visible));
    expect(layoutGraph(reversedVisible)).toEqual(layoutGraph(visible));
    expect(layoutGraph(visible).nodes.slice(0, 2).map((node) => node.id)).toEqual(["module-api", "module-web"]);
  });

  test("preserves the graph format and data relationship in API client return types", () => {
    expectTypeOf<ProjectGraphResponse<"json" | "tree">>().toEqualTypeOf<ProjectGraphResponse<"json"> | ProjectGraphResponse<"tree">>();
    expectTypeOf<KnowledgeGraphNode["attributes"]>().toEqualTypeOf<Record<string, unknown>>();
  });
});
