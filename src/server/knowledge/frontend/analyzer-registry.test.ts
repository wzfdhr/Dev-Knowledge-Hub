import { z } from "zod";
import { describe, expect, test } from "vitest";

import { createFrontendEntityId } from "./analyzer.js";
import { AnalyzerRegistry } from "./analyzer-registry.js";

const digest = "a".repeat(64);
const ref = (startLine: number) => ({
  snapshotId: "snapshot-1", path: "src/app.tsx", startLine, endLine: startLine, blobHash: digest
});

function component(name = "DashboardPage", startLine = 1) {
  return {
    schemaVersion: 2 as const,
    id: createFrontendEntityId({ kind: "component", packageKey: "app", canonicalPath: "src/app.tsx", semanticKey: name }),
    kind: "component" as const,
    completeness: "complete" as const,
    packageKey: "app",
    canonicalPath: "src/app.tsx",
    semanticKey: name,
    attributes: {
      name: { status: "known" as const, value: name },
      componentType: { status: "known" as const, value: "function" as const }
    },
    facets: { react: { hookCount: 2 } },
    sourceRefs: [ref(startLine)],
    provenance: [{ analyzerId: "react", analyzerVersion: "1.0.0", configDigest: digest }]
  };
}

describe("frontend analyzer registry", () => {
  test("creates stable semantic ids independent of source offsets", () => {
    const input = { kind: "component", packageKey: "app", canonicalPath: "src/../src/app.tsx", semanticKey: "DashboardPage" };
    expect(createFrontendEntityId(input)).toBe(createFrontendEntityId({ ...input, canonicalPath: "src/app.tsx" }));
    expect(createFrontendEntityId(input)).not.toBe(createFrontendEntityId({ ...input, semanticKey: "SettingsPage" }));
  });

  test("validates only the analyzer-owned facet namespace", () => {
    const registry = new AnalyzerRegistry();
    registry.register({ id: "react", version: "1.0.0", facetSchema: z.object({ hookCount: z.number().int().nonnegative() }) });
    expect(() => registry.validateOutput({ analyzerId: "react", analyzerVersion: "1.0.0", entities: [component()], edges: [] })).not.toThrow();
    expect(() => registry.validateOutput({
      analyzerId: "react", analyzerVersion: "1.0.0",
      entities: [{ ...component(), facets: { react: { hookCount: "two" } } }], edges: []
    })).toThrow();
    expect(() => registry.validateOutput({
      analyzerId: "react", analyzerVersion: "1.0.0",
      entities: [{ ...component(), facets: { react: { hookCount: 2 }, foreign: {} } }], edges: []
    })).toThrow("foreign facet namespace");
    expect(() => registry.validateOutput({
      analyzerId: "react", analyzerVersion: "1.0.0",
      entities: [{ ...component(), id: "f".repeat(64) }], edges: []
    })).toThrow("stable identity");
    expect(() => registry.validateOutput({
      analyzerId: "react", analyzerVersion: "1.0.0",
      entities: [{ ...component(), provenance: [
        ...component().provenance,
        { analyzerId: "foreign", analyzerVersion: "1.0.0", configDigest: digest }
      ] }], edges: []
    })).toThrow("foreign analyzer provenance");
  });

  test("merges references deterministically and blocks canonical conflicts", () => {
    const registry = new AnalyzerRegistry();
    registry.register({ id: "react", version: "1.0.0", facetSchema: z.object({ hookCount: z.number() }) });
    const first = { analyzerId: "react", analyzerVersion: "1.0.0", entities: [component("DashboardPage", 3)], edges: [] };
    const second = { analyzerId: "react", analyzerVersion: "1.0.0", entities: [component("DashboardPage", 1)], edges: [] };
    const merged = registry.mergeOutputs([first, second]);
    expect(merged.valid).toBe(true);
    expect(merged.ir.entities[0]?.sourceRefs.map((item) => item.startLine)).toEqual([1, 3]);
    expect(registry.mergeOutputs([second, first])).toEqual(merged);

    const conflict = registry.mergeOutputs([first, {
      ...second,
      entities: [{
        ...component("DashboardPage", 1),
        attributes: {
          ...component("DashboardPage", 1).attributes,
          name: { status: "known" as const, value: "ConflictingName" }
        }
      }]
    }]);
    expect(conflict.valid).toBe(false);
    expect(conflict.lintIssues).toContainEqual(expect.objectContaining({ rule: "FRONTEND_CANONICAL_CONFLICT", severity: "error" }));
  });
});
