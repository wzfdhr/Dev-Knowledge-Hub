import { z } from "zod";
import { describe, expect, test } from "vitest";

import {
  anonymousFrontendIdentity,
  createFrontendEdgeId,
  createFrontendEntityId,
  namedFrontendIdentity,
  type FrontendAnalyzerOutput
} from "./analyzer.js";
import { AnalyzerRegistry } from "./analyzer-registry.js";

const digest = "a".repeat(64);
const secondDigest = "b".repeat(64);
const ref = (startLine: number, blobHash = digest) => ({
  snapshotId: "snapshot-1", path: "src/app.tsx", startLine, endLine: startLine, blobHash
});

function provenance(analyzerId: string) {
  return [{ analyzerId, analyzerVersion: "1.0.0", parserConfigDigest: digest, sourceBlobHashes: [digest] }];
}

function component(analyzerId = "core-typescript", startLine = 1) {
  const identity = namedFrontendIdentity("DashboardPage");
  return {
    schemaVersion: 2 as const,
    id: createFrontendEntityId({ kind: "component", packageKey: "app", canonicalPath: "src/app.tsx", identity }),
    kind: "component" as const,
    name: "DashboardPage",
    qualifiedName: "app.DashboardPage",
    completeness: "complete" as const,
    packageKey: "app",
    canonicalPath: "src/app.tsx",
    identity,
    attributes: { componentType: { state: "known" as const, value: "function" as const } },
    facets: {},
    sourceRefs: [ref(startLine)],
    provenance: provenance(analyzerId)
  };
}

function output(analyzerId: string, values: Partial<FrontendAnalyzerOutput> = {}): FrontendAnalyzerOutput {
  return {
    snapshotId: "snapshot-1", analyzerId, analyzerVersion: "1.0.0",
    parserConfigDigest: digest, sourceBlobHashes: [digest], entities: [], edges: [], facetPatches: [], ...values
  };
}

function registry() {
  const value = new AnalyzerRegistry();
  value.register({ id: "core-typescript", version: "1.0.0", role: "core", facetSchema: z.object({ value: z.number().optional() }).strict() });
  value.register({ id: "core-html", version: "1.0.0", role: "core", facetSchema: z.object({}).strict() });
  value.register({ id: "react", version: "1.0.0", role: "framework", facetSchema: z.object({ hookCount: z.number().int().nonnegative() }) });
  value.register({ id: "router", version: "1.0.0", role: "framework", facetSchema: z.object({ routeCount: z.number().int() }) });
  return value;
}

describe("frontend analyzer registry", () => {
  test("creates stable named, anonymous, and evidence-specific ids", () => {
    const named = { kind: "component" as const, packageKey: "app", canonicalPath: "src/../src/app.tsx", identity: namedFrontendIdentity("DashboardPage") };
    expect(createFrontendEntityId(named)).toBe(createFrontendEntityId({ ...named, canonicalPath: "src/app.tsx" }));
    expect(anonymousFrontendIdentity("DashboardPage", 2)).toEqual({ type: "anonymous", enclosingSemanticKey: "DashboardPage", astOrdinal: 2 });
    expect(() => anonymousFrontendIdentity("DashboardPage", -1)).toThrow();
    const fromEntityId = "c".repeat(64);
    const toEntityId = "d".repeat(64);
    expect(createFrontendEdgeId({ kind: "renders", fromEntityId, toEntityId, canonicalEvidenceKey: "jsx:1" }))
      .not.toBe(createFrontendEdgeId({ kind: "renders", fromEntityId, toEntityId, canonicalEvidenceKey: "heuristic:1" }));
  });

  test("prevents framework analyzers from writing canonical entities and validates their facets", () => {
    const value = registry();
    expect(() => value.validateOutput(output("react", { entities: [component("react")] }))).toThrow("cannot create canonical");
    expect(() => value.validateOutput(output("react", {
      facetPatches: [{ entityId: component().id, facet: { hookCount: "two" }, sourceRefs: [ref(1)] }]
    }))).toThrow();
    expect(() => value.validateOutput(output("react", {
      sourceBlobHashes: [secondDigest],
      facetPatches: [{ entityId: component().id, facet: { hookCount: 2 }, sourceRefs: [ref(1)] }]
    }))).toThrow("absent from analyzer provenance");
  });

  test("merges framework facets and references deterministically", () => {
    const value = registry();
    const core = output("core-typescript", { entities: [component("core-typescript", 3)] });
    const react = output("react", {
      facetPatches: [{ entityId: component().id, facet: { hookCount: 2 }, sourceRefs: [ref(1)] }]
    });
    const merged = value.mergeOutputs([react, core]);
    expect(merged.valid).toBe(true);
    if (!merged.valid) throw new Error("Expected valid merge");
    expect(merged.ir.entities[0]?.facets).toEqual({ react: { hookCount: 2 } });
    expect(merged.ir.entities[0]?.sourceRefs.map((item) => item.startLine)).toEqual([1, 3]);
    expect(value.mergeOutputs([core, react])).toEqual(merged);
  });

  test("keeps independently owned analyzer evidence and only merges schema-parsed facets", () => {
    const value = registry();
    const core = output("core-typescript", { entities: [component("core-typescript", 3)] });
    const react = output("react", {
      sourceBlobHashes: [secondDigest],
      facetPatches: [{
        entityId: component().id,
        facet: { hookCount: 2, undeclared: true },
        sourceRefs: [ref(4, secondDigest)]
      }]
    });

    const merged = value.mergeOutputs([core, react]);
    expect(merged.valid).toBe(true);
    if (!merged.valid) throw new Error("Expected valid merge");
    expect(merged.ir.entities[0]?.facets).toEqual({ react: { hookCount: 2 } });
    expect(merged.ir.entities[0]?.sourceRefs.map((item) => item.blobHash)).toEqual([digest, secondDigest]);
    expect(merged.ir.entities[0]?.provenance.flatMap((item) => item.sourceBlobHashes).sort())
      .toEqual([digest, secondDigest].sort());
  });

  test("includes empty analyzers in the manifest and supports a valid empty IR", () => {
    const value = registry();
    const emptyCore = output("core-typescript");
    const emptyFramework = output("router", { parserConfigDigest: secondDigest, sourceBlobHashes: [] });
    const merged = value.mergeOutputs([emptyFramework, emptyCore]);
    expect(merged.valid).toBe(true);
    if (!merged.valid) throw new Error("Expected valid merge");
    expect(merged.ir.entities).toEqual([]);
    expect(merged.ir.analyzerManifest.map((item) => item.analyzerId)).toEqual(["core-typescript", "router"]);
  });

  test("returns no usable IR for canonical or facet conflicts", () => {
    const value = registry();
    const first = output("core-typescript", { entities: [component("core-typescript")] });
    const conflictingEntity = {
      ...component("core-html"),
      attributes: { componentType: { state: "known" as const, value: "class" as const } }
    };
    const canonicalConflict = value.mergeOutputs([first, output("core-html", { entities: [conflictingEntity] })]);
    expect(canonicalConflict).toMatchObject({ valid: false, ir: null, lintIssues: [{ rule: "FRONTEND_CANONICAL_CONFLICT" }] });

    const patch = (hookCount: number) => output("react", {
      facetPatches: [{ entityId: component().id, facet: { hookCount }, sourceRefs: [ref(1)] }]
    });
    const facetConflict = value.mergeOutputs([first, patch(1), patch(2)]);
    expect(facetConflict).toMatchObject({ valid: false, ir: null, lintIssues: [{ rule: "FRONTEND_FACET_CONFLICT" }] });

    const coreFacet = (value: number) => output("core-typescript", {
      entities: [{ ...component("core-typescript"), facets: { "core-typescript": { value } } }]
    });
    expect(value.mergeOutputs([coreFacet(1), coreFacet(2)])).toMatchObject({
      valid: false, ir: null, lintIssues: [{ rule: "FRONTEND_FACET_CONFLICT" }]
    });
  });
});
