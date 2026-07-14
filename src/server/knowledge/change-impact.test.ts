import { describe, expect, test } from "vitest";

import { deriveChangeImpact } from "./change-impact";

describe("deriveChangeImpact", () => {
  test("maps changed source files through published dependency and test edges", () => {
    const impact = deriveChangeImpact({
      snapshotId: "snapshot-2",
      previousSnapshotId: "snapshot-1",
      added: ["src/new.ts"],
      modified: ["src/math.ts"],
      deleted: [],
      requiresBuild: true,
      affectedModules: [],
      suggestedTests: []
    }, {
      symbols: [],
      dependencies: [
        { source: "src/math.ts", target: "src/util.js", kind: "module-dependency", path: "src/math.ts", targetPath: "src/util.js", startLine: 1, endLine: 1 },
        { source: "test/math.test.ts", target: "src/math.ts", kind: "test-of", path: "test/math.test.ts", targetPath: "src/math.ts", startLine: 1, endLine: 1 },
        { source: "src/untouched.ts", target: "src/util.js", kind: "module-dependency", path: "src/untouched.ts", targetPath: "src/util.js", startLine: 1, endLine: 1 }
      ]
    });

    expect(impact.affectedModules).toEqual(["src/math.ts", "src/util.js", "test/math.test.ts"]);
    expect(impact.suggestedTests).toEqual(["test/math.test.ts"]);
  });
});
