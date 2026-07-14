import { describe, expect, test } from "vitest";

import { planInvalidation } from "./invalidation";

describe("planInvalidation", () => {
  test("rebuilds only changed source inputs and their dependent pipeline stages", () => {
    const plan = planInvalidation({
      added: [], modified: ["src/a.ts"], deleted: [],
      affectedModules: ["src/a.ts", "src/dependent.ts"], suggestedTests: ["test/a.test.ts"]
    });

    expect(plan.rebuildStages.get("src/a.ts")).toEqual([
      "convert", "extract", "graph", "synthesize", "index", "lint", "viz", "validate", "package"
    ]);
    expect(plan.rebuildStages.has("src/dependent.ts")).toBe(false);
    expect(plan.affectedModules).toEqual(["src/a.ts", "src/dependent.ts"]);
    expect(plan.suggestedTests).toEqual(["test/a.test.ts"]);
  });

  test("includes table parsing only for changed CSV/XLSX files and reuses all stages for no-op syncs", () => {
    expect(planInvalidation({ added: ["data/usage.xlsx"], modified: [], deleted: [], affectedModules: [], suggestedTests: [] })
      .rebuildStages.get("data/usage.xlsx")).toContain("tables");
    expect(planInvalidation({ added: [], modified: [], deleted: [], affectedModules: [], suggestedTests: [] }))
      .toMatchObject({ rebuildStages: new Map(), stages: [] });
  });
});
