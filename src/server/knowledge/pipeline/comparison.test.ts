import { expect, test } from "vitest";

import { compareKnowledgeKernelOutputs } from "./comparison";

const citation = {
  path: "src/math.ts", startLine: 1, endLine: 4, commitSha: "a".repeat(40), blobHash: "b".repeat(64)
};

test("classifies compatible additions separately from missing required legacy knowledge", () => {
  const comparison = compareKnowledgeKernelOutputs({
    legacy: {
      pages: [{ key: "math", citations: [citation] }],
      graph: { nodes: ["module:src/math.ts"], edges: ["imports:src/app.ts->src/math.ts"] },
      search: [{ key: "math:0", citations: [citation] }],
      quality: { issueCount: 0, trust: null }
    },
    pipeline: {
      pages: [{ key: "math", citations: [citation] }, { key: "commands", citations: [citation] }],
      graph: { nodes: ["module:src/math.ts"], edges: ["imports:src/app.ts->src/math.ts"] },
      search: [{ key: "math:0", citations: [citation] }, { key: "commands:0", citations: [citation] }],
      quality: { issueCount: 1, trust: 0.91 }
    }
  });

  expect(comparison.blockingDefects).toEqual([]);
  expect(comparison.compatibilityDifferences).toEqual([]);
  expect(comparison.expectedImprovements).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: "pages", key: "commands" }),
    expect.objectContaining({ area: "search", key: "commands:0" }),
    expect.objectContaining({ area: "quality", key: "trust" })
  ]));
  expect(comparison.citations.valid).toBe(true);
});

test("treats a missing legacy page or invalid pipeline citation as a blocking defect", () => {
  const comparison = compareKnowledgeKernelOutputs({
    legacy: {
      pages: [{ key: "math", citations: [citation] }, { key: "deployment", citations: [citation] }],
      graph: { nodes: [], edges: [] }, search: [], quality: { issueCount: 0, trust: null }
    },
    pipeline: {
      pages: [{ key: "math", citations: [{ ...citation, endLine: 0 }] }],
      graph: { nodes: [], edges: [] }, search: [], quality: { issueCount: 0, trust: null }
    }
  });

  expect(comparison.blockingDefects).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: "pages", key: "deployment", reason: "missing_in_pipeline" }),
    expect.objectContaining({ area: "citations", key: "src/math.ts:1:0", reason: "invalid_citation" })
  ]));
  expect(comparison.citations.valid).toBe(false);
});
