import { describe, expect, test } from "vitest";

import type { GraphEdge, GraphNode, SourceRef } from "../../shared/api-contracts.js";
import { deriveRemediationScope } from "./remediation-scope.js";

const sourceRef = (path: string): SourceRef => ({
  snapshotId: "snapshot-1", path, startLine: 1, endLine: 1, blobHash: "a".repeat(64)
});
const node = (id: string, path: string): GraphNode => ({
  id, projectId: "project-1", snapshotId: "snapshot-1", kind: "module", name: path,
  qualifiedName: path, candidate: false, sourceRefs: [sourceRef(path)], attributes: {}
});
const edge = (id: string, fromNodeId: string, toNodeId: string, candidate = false): GraphEdge => ({
  id, fromNodeId, toNodeId, kind: "imports", candidate,
  ...(candidate ? { candidateReason: "dynamic import" } : {}), confidence: candidate ? 0.5 : 1,
  sourceRefs: [sourceRef("src/edge.ts")]
});

describe("deriveRemediationScope", () => {
  test("includes the source paths and their fact-graph reverse dependency closure", () => {
    const scope = deriveRemediationScope({
      sourceRefs: [sourceRef("src/core.ts")],
      graph: {
        nodes: [node("core", "src/core.ts"), node("service", "src/service.ts"), node("screen", "src/screen.ts"), node("candidate", "src/candidate.ts")],
        edges: [
          edge("service-imports-core", "service", "core"),
          edge("screen-imports-service", "screen", "service"),
          edge("candidate-imports-core", "candidate", "core", true)
        ]
      }
    });

    expect(scope).toEqual(["src/core.ts", "src/screen.ts", "src/service.ts"]);
  });

  test("retains source paths when the source build has no graph artifact", () => {
    expect(deriveRemediationScope({ sourceRefs: [sourceRef("docs/runbook.md")], graph: null }))
      .toEqual(["docs/runbook.md"]);
  });
});
