import { describe, expect, test } from "vitest";

import { deriveFrontendChangeImpact } from "./change-impact.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";

describe("deriveFrontendChangeImpact", () => {
  test("traces changed API facts back to pages and tests without traversing candidates", () => {
    const ref = (path: string) => ({ snapshotId: "snapshot", path, startLine: 1, endLine: 2, blobHash: "1".repeat(64) });
    const ir = {
      entities: [
        { id: "page", kind: "page", name: "Dashboard", sourceRefs: [ref("src/page.tsx")] },
        { id: "component", kind: "component", name: "Dashboard", sourceRefs: [ref("src/page.tsx")] },
        { id: "api", kind: "api_operation", name: "GET /api", sourceRefs: [ref("src/api.ts")] },
        { id: "test", kind: "test_case", name: "dashboard test", sourceRefs: [ref("src/page.test.tsx")] },
        { id: "style", kind: "style_scope", name: ".page", sourceRefs: [ref("src/page.css")] }
      ],
      edges: [
        { kind: "renders", fromEntityId: "page", toEntityId: "component", evidenceClass: "fact" },
        { kind: "requests", fromEntityId: "component", toEntityId: "api", evidenceClass: "fact" },
        { kind: "tests", fromEntityId: "test", toEntityId: "component", evidenceClass: "fact" },
        { kind: "styles", fromEntityId: "component", toEntityId: "style", evidenceClass: "candidate" }
      ]
    } as unknown as FrontendIR;
    const impact = deriveFrontendChangeImpact({ changedPaths: ["src/api.ts"], graph: ir });

    expect(impact.affectedEntityIds).toEqual(["api", "component", "page", "test"]);
    expect(impact.affectedPageIds).toEqual(["page"]);
    expect(impact.suggestedTestIds).toEqual(["test"]);
    expect(impact.affectedEntityIds).not.toContain("style");
  });

  test("does not walk from a changed consumer into its dependencies", () => {
    const ref = (path: string) => ({ snapshotId: "snapshot", path, startLine: 1, endLine: 2, blobHash: "1".repeat(64) });
    const ir = {
      entities: [
        { id: "page", kind: "page", name: "Dashboard", sourceRefs: [ref("src/page.tsx")] },
        { id: "api", kind: "api_operation", name: "GET /api", sourceRefs: [ref("src/api.ts")] },
        { id: "store", kind: "state_store", name: "dashboard", sourceRefs: [ref("src/store.ts")] }
      ],
      edges: [
        { kind: "requests", fromEntityId: "page", toEntityId: "api", evidenceClass: "fact" },
        { kind: "reads_state", fromEntityId: "page", toEntityId: "store", evidenceClass: "fact" }
      ]
    } as unknown as FrontendIR;

    expect(deriveFrontendChangeImpact({ changedPaths: ["src/page.tsx"], graph: ir }).affectedEntityIds)
      .toEqual(["page"]);
  });
});
