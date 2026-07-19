import { describe, expect, test } from "vitest";

import { generateFrontendKnowledge } from "./knowledge-generator.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";

describe("generateFrontendKnowledge", () => {
  test("generates architecture, route, component, data, chart, and tooling pages with citations", () => {
    const ref = { snapshotId: "snapshot", path: "src/app.tsx", startLine: 1, endLine: 3, blobHash: "1".repeat(64) };
    const kinds = ["workspace_package", "route", "component", "state_store", "api_operation", "visualization", "tooling_config", "test_case"];
    const ir = {
      snapshotId: "snapshot",
      entities: kinds.map((kind, index) => ({ id: `${kind}-${index}`, kind, name: `${kind}-${index}`, qualifiedName: `${kind}-${index}`, canonicalPath: ref.path, packageKey: "app", sourceRefs: [ref], facets: {} })),
      edges: []
    } as unknown as FrontendIR;
    const output = generateFrontendKnowledge(ir);

    expect(output.pages.map((page) => page.slug)).toEqual([
      "frontend-architecture", "frontend-components", "frontend-data", "frontend-routes", "frontend-tooling-tests", "frontend-visualizations"
    ]);
    expect(output.pages.every((page) => page.citations.length > 0 && page.chunks.every((chunk) => chunk.citations.length > 0))).toBe(true);
  });
});
