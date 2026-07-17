import { describe, expect, test } from "vitest";

import type { KnowledgeGraph } from "../../api/types";
import { describeGraphReduction, filterGraph, layoutGraph } from "./graph-view-model";

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

    expect(result.nodes.map((node) => node.id)).toEqual(["module-api", "module-web", "symbol-client", "document-readme"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["contains-client", "imports-web"]);
  });

  test("excludes candidate nodes and edges until explicitly enabled", () => {
    const base = graph({ nodes: [...graph().nodes, { id: "candidate-command", projectId: "project", snapshotId: "snapshot", kind: "command", name: "Start", qualifiedName: "npm start", candidate: true, sourceRefs: [], attributes: {} }] });
    const hidden = filterGraph({ graph: base, query: "", enabledKinds: new Set(["module", "symbol", "document", "command"]), includeCandidates: false });
    const shown = filterGraph({ graph: base, query: "", enabledKinds: new Set(["module", "symbol", "document", "command"]), includeCandidates: true });

    expect(hidden.nodes.map((node) => node.id)).not.toContain("candidate-command");
    expect(hidden.edges.map((edge) => edge.id)).not.toContain("candidate-document");
    expect(shown.nodes.map((node) => node.id)).toContain("candidate-command");
    expect(shown.edges.map((edge) => edge.id)).toContain("candidate-document");
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

    expect(layoutGraph(visible)).toEqual(layoutGraph(visible));
    expect(layoutGraph(visible).nodes.slice(0, 2).map((node) => node.id)).toEqual(["module-api", "module-web"]);
  });
});
