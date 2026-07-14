import { describe, expect, test } from "vitest";

import { lintKnowledge } from "./lint";

const sourceRef = { snapshotId: "snapshot-1", path: "src/main.ts", startLine: 1, endLine: 1, blobHash: "a".repeat(64) };

describe("lintKnowledge", () => {
  test("reports sourced facts, dangling edges, sensitive table fields, and low page coverage deterministically", () => {
    const issues = lintKnowledge({
      buildId: "build-1",
      graph: {
        nodes: [{ id: "module", projectId: "p", snapshotId: "snapshot-1", kind: "module", name: "main", qualifiedName: "src/main.ts", candidate: false, sourceRefs: [sourceRef], attributes: {} }],
        edges: [{ id: "dangling", fromNodeId: "module", toNodeId: "missing", kind: "imports", candidate: false, confidence: 1, sourceRefs: [sourceRef] }]
      },
      tables: [{ id: "users", name: "users", sourcePath: "data/users.csv", rowCount: 2, candidate: false, sourceRefs: [sourceRef], columns: [{ name: "email", type: "string", nullable: false, sensitive: true, formulaLike: false, sourceRefs: [sourceRef] }] }],
      knowledgePageCount: 0
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "GRAPH_DANGLING_FACT_EDGE", severity: "error" }),
      expect.objectContaining({ rule: "TABLE_SENSITIVE_FIELD", severity: "warning" }),
      expect.objectContaining({ rule: "KNOWLEDGE_LOW_COVERAGE", severity: "warning" })
    ]));
    expect(issues.map((issue) => issue.id)).toEqual([...issues.map((issue) => issue.id)].sort());
  });
});
