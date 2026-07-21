import { describe, expect, test } from "vitest";

import { lintFrontendIr } from "./frontend-static-lint.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";

describe("lintFrontendIr", () => {
  test("reports actionable chart lifecycle and test coverage candidates", () => {
    const ir = {
      schemaVersion: 2,
      snapshotId: "snapshot-lint",
      analyzerManifestDigest: "0".repeat(64),
      analyzerManifest: [],
      entities: [
        { id: "chart", kind: "visualization", name: "DashboardChart", facets: { "visualization-core": { initialized: true, disposes: false, resizes: false } }, sourceRefs: [{ snapshotId: "snapshot-lint", path: "src/chart.tsx", startLine: 3, endLine: 8, blobHash: "1".repeat(64) }] },
        { id: "component", kind: "component", name: "DashboardPage", facets: {}, sourceRefs: [{ snapshotId: "snapshot-lint", path: "src/app.tsx", startLine: 4, endLine: 10, blobHash: "2".repeat(64) }] }
      ],
      edges: []
    } as unknown as FrontendIR;
    const issues = lintFrontendIr(ir);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "ECHARTS_MISSING_DISPOSE", severity: "warning", targetId: "chart" }),
      expect.objectContaining({ rule: "ECHARTS_MISSING_RESIZE", severity: "info", targetId: "chart" }),
      expect.objectContaining({ rule: "FRONTEND_COMPONENT_UNTESTED", severity: "info", targetId: "component" })
    ]));
  });

  test("does not report lifecycle or coverage issues when facts exist", () => {
    const ir = {
      entities: [
        { id: "chart", kind: "visualization", facets: { "visualization-core": { initialized: true, disposes: true, resizes: true } }, sourceRefs: [] },
        { id: "component", kind: "component", facets: {}, sourceRefs: [] },
        { id: "test", kind: "test_case", facets: {}, sourceRefs: [] }
      ],
      edges: [{ kind: "tests", fromEntityId: "test", toEntityId: "component" }]
    } as unknown as FrontendIR;

    expect(lintFrontendIr(ir)).toEqual([]);
  });
});
