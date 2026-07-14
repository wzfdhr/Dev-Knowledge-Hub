import { describe, expect, test } from "vitest";

import { buildImpactMindmap } from "./mindmap";

const sourceRef = (path: string) => ({
  snapshotId: "snapshot-1", path, startLine: 1, endLine: 1, blobHash: "a".repeat(64)
});
const node = (id: string, path: string) => ({
  id, projectId: "project-1", snapshotId: "snapshot-1", kind: "module" as const,
  name: path, qualifiedName: path, candidate: false, sourceRefs: [sourceRef(path)], attributes: {}
});
const edge = (id: string, fromNodeId: string, toNodeId: string, kind: "contains" | "imports", candidate = false) => ({
  id, fromNodeId, toNodeId, kind, candidate, ...(candidate ? { candidateReason: "unresolved_import" } : {}),
  confidence: candidate ? 0.5 : 1, sourceRefs: [sourceRef("src/a.ts")]
});

describe("buildImpactMindmap", () => {
  test("uses fact containment and one-hop dependencies while excluding candidates", () => {
    const output = buildImpactMindmap({
      changedPaths: ["src/a.ts"],
      graph: {
        nodes: [node("root", "src"), node("a", "src/a.ts"), node("b", "src/b.ts"), node("c", "src/c.ts")],
        edges: [
          edge("contains-a", "root", "a", "contains"),
          edge("contains-b", "root", "b", "contains"),
          edge("imports-a-b", "a", "b", "imports"),
          edge("candidate-a-c", "a", "c", "imports", true)
        ]
      }
    });

    expect(output.affectedModulePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(output.roots).toEqual([expect.objectContaining({ id: "root", children: expect.arrayContaining([
      expect.objectContaining({ id: "a", changed: true })
    ]) })]);
    expect(output.crossLinks).toEqual([expect.objectContaining({ id: "imports-a-b" })]);
    expect(output.crossLinks).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "candidate-a-c" })]));
  });

  test("keeps deleted paths visible without inventing dangling graph nodes or looping on cycles", () => {
    const output = buildImpactMindmap({
      changedPaths: ["src/a.ts", "src/deleted.ts"],
      graph: {
        nodes: [node("a", "src/a.ts"), node("b", "src/b.ts")],
        edges: [edge("a-b", "a", "b", "contains"), edge("b-a", "b", "a", "contains")]
      }
    });

    expect(output.deletedPaths).toEqual(["src/deleted.ts"]);
    expect(output.affectedModulePaths).toEqual(["src/a.ts"]);
    expect(output.roots).toHaveLength(1);
    expect(output.crossLinks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b-a" })]));
  });
});
