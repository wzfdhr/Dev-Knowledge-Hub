import { describe, expect, test } from "vitest";

import { deriveChangeImpact } from "./change-impact";

describe("deriveChangeImpact", () => {
  test("maps changed source files through published dependency and test edges", () => {
    const impact = deriveChangeImpact({
      snapshotId: "snapshot-2",
      previousSnapshotId: "snapshot-1",
      added: ["src/new.ts"],
      modified: ["src/math.ts"],
      deleted: [],
      requiresBuild: true,
      affectedModules: [],
      suggestedTests: []
    }, {
      symbols: [],
      dependencies: [
        { source: "src/math.ts", target: "src/util.js", kind: "module-dependency", path: "src/math.ts", targetPath: "src/util.js", startLine: 1, endLine: 1 },
        { source: "test/math.test.ts", target: "src/math.ts", kind: "test-of", path: "test/math.test.ts", targetPath: "src/math.ts", startLine: 1, endLine: 1 },
        { source: "src/untouched.ts", target: "src/util.js", kind: "module-dependency", path: "src/untouched.ts", targetPath: "src/util.js", startLine: 1, endLine: 1 }
      ]
    });

    expect(impact.affectedModules).toEqual(["src/math.ts", "src/util.js", "test/math.test.ts"]);
    expect(impact.suggestedTests).toEqual(["test/math.test.ts"]);
  });

  test("adds only fact graph neighbors to the change impact", () => {
    const sourceRef = (path: string) => ({
      snapshotId: "snapshot-2", path, startLine: 1, endLine: 1, blobHash: "a".repeat(64)
    });
    const impact = deriveChangeImpact({
      snapshotId: "snapshot-2", previousSnapshotId: "snapshot-1", added: [], modified: ["src/a.ts"], deleted: [],
      requiresBuild: true, affectedModules: [], suggestedTests: []
    }, { symbols: [], dependencies: [] }, {
      nodes: ["a", "b", "c"].map((id) => ({
        id, projectId: "project-1", snapshotId: "snapshot-2", kind: "module" as const,
        name: `src/${id}.ts`, qualifiedName: `src/${id}.ts`, candidate: false,
        sourceRefs: [sourceRef(`src/${id}.ts`)], attributes: {}
      })),
      edges: [
        { id: "fact", fromNodeId: "a", toNodeId: "b", kind: "imports" as const, candidate: false, confidence: 1, sourceRefs: [sourceRef("src/a.ts")] },
        { id: "candidate", fromNodeId: "a", toNodeId: "c", kind: "imports" as const, candidate: true, candidateReason: "dynamic_import", confidence: 0.5, sourceRefs: [sourceRef("src/a.ts")] }
      ]
    });

    expect(impact.affectedModules).toEqual(["src/a.ts", "src/b.ts"]);
    expect(impact.impact?.affectedModulePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(impact.impact?.crossLinks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "candidate" })
    ]));
  });
});
