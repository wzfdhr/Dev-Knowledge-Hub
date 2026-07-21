import { describe, expect, test } from "vitest";

import { compareFrontendKnowledge } from "./comparison.js";

describe("compareFrontendKnowledge", () => {
  test("compares entities, facts, pages, search, impact, quality, and citations without promoting candidates", () => {
    const ref = { snapshotId: "snapshot", path: "src/app.tsx", startLine: 1, endLine: 3, blobHash: "1".repeat(64) };
    const result = compareFrontendKnowledge({
      legacy: { entityKeys: ["module:src/app.tsx"], factKeys: [], pageKeys: ["architecture"], searchKeys: ["architecture:0"], impactPaths: ["src/app.tsx"], suggestedTestPaths: ["src/app.test.tsx"], issueCount: 0 },
      candidate: {
        snapshotId: "snapshot",
        sources: new Map([["src/app.tsx", { path: "src/app.tsx", blobHash: "1".repeat(64), lineCount: 3 }]]),
        pageRefs: [ref], searchRefs: [ref], issueRefs: [ref],
        entities: [{ id: "component", kind: "component", canonicalPath: "src/app.tsx", name: "App", sourceRefs: [ref] }],
        edges: [
          { id: "fact", kind: "renders", fromEntityId: "component", toEntityId: "chart", evidenceClass: "fact", sourceRefs: [ref] },
          { id: "candidate", kind: "styles", fromEntityId: "component", toEntityId: "style", evidenceClass: "candidate", sourceRefs: [] }
        ],
        pageKeys: ["frontend-architecture"], searchKeys: ["frontend-architecture:0"], impactPaths: ["src/app.tsx"], suggestedTestPaths: ["src/app.test.tsx"], issueCount: 1
      }
    });

    expect(result.candidate).toMatchObject({ entities: 1, factRelations: 1, candidateRelations: 1, pages: 1, searchDocuments: 1, impactPaths: 1, issues: 1 });
    expect(result.citations).toEqual({ valid: true, checked: 5, invalid: [] });
    expect(result.candidateFactKeys).toEqual(["renders:component->chart"]);
    expect(result.candidateFactKeys).not.toContain("styles:component->style");
    expect(result.impact.candidateSuggestedTests).toEqual(["src/app.test.tsx"]);
  });

  test("rejects a structurally valid citation from another snapshot", () => {
    const ref = { snapshotId: "other", path: "src/app.tsx", startLine: 1, endLine: 1, blobHash: "1".repeat(64) };
    const result = compareFrontendKnowledge({
      legacy: { entityKeys: [], factKeys: [], pageKeys: [], searchKeys: [], impactPaths: [], suggestedTestPaths: [], issueCount: 0 },
      candidate: { snapshotId: "snapshot", sources: new Map([["src/app.tsx", { path: "src/app.tsx", blobHash: "1".repeat(64), lineCount: 1 }]]), pageRefs: [], searchRefs: [], issueRefs: [], entities: [{ id: "app", kind: "component", canonicalPath: "src/app.tsx", name: "App", sourceRefs: [ref] }], edges: [], pageKeys: [], searchKeys: [], impactPaths: [], suggestedTestPaths: [], issueCount: 0 }
    });

    expect(result.citations).toEqual({ valid: false, checked: 1, invalid: ["src/app.tsx:1-1"] });
  });
});
