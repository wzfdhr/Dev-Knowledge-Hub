import { describe, expect, test } from "vitest";

import { assessKnowledgeQuality } from "./quality-assessment";

const sourceRef = {
  snapshotId: "snapshot-1", path: "data/users.csv", startLine: 1, endLine: 2, blobHash: "a".repeat(64)
};

describe("assessKnowledgeQuality", () => {
  test("derives deterministic lint and trust from the immutable knowledge IR", () => {
    const quality = assessKnowledgeQuality({
      buildId: "build-1",
      projectId: "project-1",
      knowledgePageCount: 1,
      extractionIssues: [],
      ir: {
        schemaVersion: 1, snapshotId: "snapshot-1", files: [], symbols: [], imports: [], documents: [],
        tables: [{
          id: "users", name: "users", sourcePath: "data/users.csv", rowCount: 1, candidate: false,
          sourceRefs: [sourceRef], columns: [{
            name: "email", type: "string", nullable: false, sensitive: true, formulaLike: false, sourceRefs: [sourceRef]
          }]
        }],
        sourceRefs: [sourceRef]
      }
    });

    expect(quality.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "table", qualifiedName: "data/users.csv" })
    ]));
    expect(quality.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "TABLE_SENSITIVE_FIELD", remediationState: "open" })
    ]));
    expect(quality.trust).toMatchObject({
      targetKind: "knowledge", targetId: "build-1", score: 0.8, reasons: expect.arrayContaining(["lint_warning"])
    });
  });
});
