import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { analyzeProjectStructure } from "./project-structure-analyzer.js";
import { AnalyzerRegistry } from "./analyzer-registry.js";
import { z } from "zod";

describe("analyzeProjectStructure", () => {
  test("adds workspace package and tsconfig entities to the validated frontend IR", () => {
    const sources = [
      { path: "package.json", content: JSON.stringify({ name: "dashboard", version: "1.0.0", packageManager: "npm@10" }) },
      { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }) }
    ].map((source) => ({ ...source, blobHash: createHash("sha256").update(source.content).digest("hex") }));
    const outputs = analyzeProjectStructure({ snapshotId: "snapshot", sources });
    const registry = new AnalyzerRegistry();
    registry.register({ id: "frontend-project-core", version: "1.0.0", role: "core", facetSchema: z.record(z.string(), z.unknown()) });
    const merged = registry.mergeOutputs(outputs);

    expect(merged.valid).toBe(true);
    expect(merged.ir?.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workspace_package", name: "dashboard", canonicalPath: "package.json" }),
      expect.objectContaining({ kind: "tooling_config", name: "tsconfig", canonicalPath: "tsconfig.json" })
    ]));
  });
});
