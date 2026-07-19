import { describe, expect, test } from "vitest";

import { assessFrontendKnowledgeQuality } from "./quality-assessment.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";

describe("assessFrontendKnowledgeQuality", () => {
  test("summarizes coverage, references, tests, and actionable static issues", () => {
    const ref = { snapshotId: "snapshot", path: "src/chart.tsx", startLine: 1, endLine: 4, blobHash: "1".repeat(64) };
    const ir = {
      entities: [
        { id: "component", kind: "component", name: "Chart", sourceRefs: [ref], facets: {} },
        { id: "chart", kind: "visualization", name: "chart", sourceRefs: [ref], facets: { "visualization-core": { initialized: true, disposes: false, resizes: false } } }
      ],
      edges: []
    } as unknown as FrontendIR;
    const quality = assessFrontendKnowledgeQuality(ir);

    expect(quality.summary).toMatchObject({ entities: 2, factEdges: 0, candidateEdges: 0, citedEntities: 2, testedComponents: 0 });
    expect(quality.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "ECHARTS_MISSING_DISPOSE" }),
      expect.objectContaining({ rule: "FRONTEND_COMPONENT_UNTESTED" })
    ]));
  });
});
