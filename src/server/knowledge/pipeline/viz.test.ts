import { describe, expect, test } from "vitest";

import { exportKnowledgeGraph } from "./viz";

const sourceRef = { snapshotId: "snapshot-1", path: "src/main.ts", startLine: 1, endLine: 1, blobHash: "a".repeat(64) };

describe("exportKnowledgeGraph", () => {
  test("escapes Mermaid and Markmap labels while preserving sourced graph JSON", () => {
    const output = exportKnowledgeGraph({
      nodes: [
        { id: "a".repeat(64), projectId: "project-1", snapshotId: "snapshot-1", kind: "module", name: "main ] --> injected", qualifiedName: "src/main.ts", candidate: false, sourceRefs: [sourceRef], attributes: {} },
        { id: "b".repeat(64), projectId: "project-1", snapshotId: "snapshot-1", kind: "symbol", name: "<script>alert(1)</script>", qualifiedName: "run", candidate: false, sourceRefs: [sourceRef], attributes: {} }
      ],
      edges: [{ id: "c".repeat(64), fromNodeId: "a".repeat(64), toNodeId: "b".repeat(64), kind: "contains", candidate: false, confidence: 1, sourceRefs: [sourceRef] }]
    });

    expect(output.mermaid).toContain('"main ] --> injected"');
    expect(output.mermaid).not.toContain("\nmain ] --> injected");
    expect(output.markmap).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output.markmap).not.toContain("<script>");
    expect(output.tree.roots).toHaveLength(1);
    expect(output.graph.nodes).toHaveLength(2);
  });

  test("keeps cycles and non-contains edges in crossLinks instead of duplicating tree nodes", () => {
    const output = exportKnowledgeGraph({
      nodes: ["a", "b"].map((id) => ({ id: id.repeat(64), projectId: "project-1", snapshotId: "snapshot-1", kind: "module" as const, name: id, qualifiedName: id, candidate: false, sourceRefs: [sourceRef], attributes: {} })),
      edges: [
        { id: "c".repeat(64), fromNodeId: "a".repeat(64), toNodeId: "b".repeat(64), kind: "contains" as const, candidate: false, confidence: 1, sourceRefs: [sourceRef] },
        { id: "d".repeat(64), fromNodeId: "b".repeat(64), toNodeId: "a".repeat(64), kind: "contains" as const, candidate: false, confidence: 1, sourceRefs: [sourceRef] },
        { id: "e".repeat(64), fromNodeId: "a".repeat(64), toNodeId: "b".repeat(64), kind: "imports" as const, candidate: false, confidence: 1, sourceRefs: [sourceRef] }
      ]
    });

    expect(output.tree.roots).toHaveLength(1);
    expect(output.tree.crossLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "d".repeat(64), cycle: true }),
      expect.objectContaining({ id: "e".repeat(64), cycle: false })
    ]));
  });
});
