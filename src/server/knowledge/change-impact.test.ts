import { describe, expect, test } from "vitest";

import { deriveChangeImpact } from "./change-impact";
import type { FrontendIR } from "../../shared/frontend-ir";

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

  test("merges frontend fact paths and test paths into the existing response contract", () => {
    const sourceRef = (path: string) => ({ snapshotId: "snapshot-2", path, startLine: 1, endLine: 1, blobHash: "a".repeat(64) });
    const frontendGraph = {
      entities: [
        { id: "page", kind: "page", sourceRefs: [sourceRef("src/page.tsx")] },
        { id: "api", kind: "api_operation", sourceRefs: [sourceRef("src/api.ts")] },
        { id: "test", kind: "test_case", sourceRefs: [sourceRef("src/page.test.tsx")] },
        { id: "style", kind: "style_scope", sourceRefs: [sourceRef("src/page.css")] }
      ],
      edges: [
        { fromEntityId: "page", toEntityId: "api", evidenceClass: "fact" },
        { fromEntityId: "test", toEntityId: "page", evidenceClass: "fact" },
        { fromEntityId: "page", toEntityId: "style", evidenceClass: "candidate" }
      ]
    } as unknown as FrontendIR;
    const impact = deriveChangeImpact({
      snapshotId: "snapshot-2", previousSnapshotId: "snapshot-1", added: [], modified: ["src/api.ts"], deleted: [],
      requiresBuild: true, affectedModules: [], suggestedTests: []
    }, { symbols: [], dependencies: [] }, null, frontendGraph);

    expect(impact.affectedModules).toEqual(["src/api.ts", "src/page.test.tsx", "src/page.tsx"]);
    expect(impact.suggestedTests).toEqual(["src/page.test.tsx"]);
    expect(impact.affectedModules).not.toContain("src/page.css");
  });
});
