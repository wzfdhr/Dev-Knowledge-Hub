import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertFrontendEvaluationReport,
  assertFrontendQualityGate,
  digestFrontendEvaluationDatasets,
  evaluateFrontendKnowledge,
  evaluateFrontendKnowledgeBySplit,
  observeFrontendEvaluationCase,
  parseFrontendEvaluationDatasets,
  type FrontendEvaluationInput,
  validateFrontendEvaluationSuite,
  validateFrontendCompatibilityFixtures,
  validateFrontendFixtureReferences,
  validateFrontendPerformanceBaseline,
  validateFrontendVersionManifestAgainstPackage
} from "../../../../scripts/evaluate-frontend-knowledge.mjs";

const root = process.cwd();

function positiveCase(id = "react-component-1") {
  return {
    id,
    scenarioKey: `${id}-scenario`,
    split: "train",
    capability: "react",
    locale: "en",
    source: "fixture",
    access: "authorized-published",
    query: "find the dashboard component",
    fixture: "react-vite",
    matchBy: "stable-id",
    expected: {
      entityIds: ["component:dashboard"],
      factEdgeIds: ["renders:app:dashboard"],
      searchEntityIds: ["component:dashboard"],
      impactEntityIds: ["component:dashboard"],
      citations: [{ entityId: "component:dashboard", path: "src/app.tsx", startLine: 8, endLine: 14 }]
    },
    forbiddenEntityIds: [],
    forbiddenFactEdgeIds: [],
    forbiddenCitations: []
  };
}

function dataset(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

describe("frontend knowledge evaluation protocol", () => {
  test("rejects empty, duplicate, uncited, ambiguous, and unpublished positive cases", () => {
    expect(() => parseFrontendEvaluationDatasets([])).toThrow("must not be empty");
    expect(() => parseFrontendEvaluationDatasets([
      { name: "one", split: "train", content: dataset([positiveCase()]) },
      { name: "two", split: "held-out", content: dataset([{ ...positiveCase(), split: "held-out" }]) }
    ])).toThrow("duplicate id");
    expect(() => parseFrontendEvaluationDatasets([
      { name: "uncited", split: "train", content: dataset([{
        ...positiveCase(), expected: { ...positiveCase().expected, citations: [] }
      }]) }
    ])).toThrow("requires at least one citation");
    expect(() => parseFrontendEvaluationDatasets([
      { name: "ambiguous", split: "train", content: dataset([{
        ...positiveCase(), matchBy: "name-or-path"
      }]) }
    ])).toThrow("matchBy must be stable-id");
    expect(() => parseFrontendEvaluationDatasets([
      { name: "unpublished", split: "train", content: dataset([{
        ...positiveCase(), access: "unpublished"
      }]) }
    ])).toThrow("negative access cases must expect no results");
  });

  test("rejects train and held-out scenario or answer fingerprint reuse", () => {
    const heldOut = {
      ...positiveCase("held-out-case"),
      scenarioKey: positiveCase().scenarioKey,
      split: "held-out"
    };
    expect(() => parseFrontendEvaluationDatasets([
      { name: "train", split: "train", content: dataset([positiveCase()]) },
      { name: "held-out", split: "held-out", content: dataset([heldOut]) }
    ])).toThrow("scenarioKey appears in both train and held-out");

    const renamed = { ...heldOut, scenarioKey: "renamed-held-out-scenario" };
    expect(() => parseFrontendEvaluationDatasets([
      { name: "train", split: "train", content: dataset([positiveCase()]) },
      { name: "held-out", split: "held-out", content: dataset([renamed]) }
    ])).toThrow("fixture appears in both train and held-out");
  });

  test("reports train and held-out independently", () => {
    const train = positiveCase("train-case");
    const heldOut = {
      ...positiveCase("held-out-case"), split: "held-out", fixture: "react-vite-held-out",
      scenarioKey: "held-out-independent", query: "find independent analytics component",
      expected: {
        ...positiveCase().expected,
        entityIds: ["component:analytics"],
        searchEntityIds: ["component:analytics"],
        impactEntityIds: ["component:analytics"],
        citations: [{ entityId: "component:analytics", path: "src/features/analytics/analytics-page.tsx", startLine: 8, endLine: 14 }]
      }
    };
    const cases = parseFrontendEvaluationDatasets([
      { name: "train", split: "train", content: dataset([train]) },
      { name: "held-out", split: "held-out", content: dataset([heldOut]) }
    ]);
    const reports = evaluateFrontendKnowledgeBySplit(cases, []);
    expect(reports.train.denominators.totalCases).toBe(1);
    expect(reports.heldOut.denominators.totalCases).toBe(1);
    expect(reports.all.denominators.totalCases).toBe(2);
  });

  test("creates a stable digest for the committed dataset contents", () => {
    const inputs: FrontendEvaluationInput[] = [
      { name: "train", split: "train", content: dataset([positiveCase()]) },
      { name: "held-out", split: "held-out", content: dataset([{ ...positiveCase("held-out"), split: "held-out" }]) }
    ];

    expect(digestFrontendEvaluationDatasets(inputs)).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestFrontendEvaluationDatasets(inputs)).toBe(digestFrontendEvaluationDatasets(inputs));
    expect(digestFrontendEvaluationDatasets([...inputs].reverse())).not.toBe(digestFrontendEvaluationDatasets(inputs));
  });

  test("rejects missing, escaping, and out-of-range fixture citations", async () => {
    const [valid] = parseFrontendEvaluationDatasets([
      { name: "valid", split: "train", content: dataset([positiveCase()]) }
    ]);
    await expect(validateFrontendFixtureReferences([valid], path.join(root, "fixtures/frontend"))).resolves.toBeUndefined();
    await expect(validateFrontendFixtureReferences([{
      ...valid,
      expected: { ...valid.expected, citations: [{ entityId: "component:dashboard", path: "../secret", startLine: 1, endLine: 1 }] }
    }], path.join(root, "fixtures/frontend"))).rejects.toThrow("escapes fixture root");
    await expect(validateFrontendFixtureReferences([{
      ...valid,
      expected: { ...valid.expected, citations: [{ entityId: "component:dashboard", path: "src/app.tsx", startLine: 1, endLine: 999 }] }
    }], path.join(root, "fixtures/frontend"))).rejects.toThrow("outside fixture line range");
  });

  test("ships the approved per-capability distribution and locked version manifest", async () => {
    const datasetFiles: Array<[FrontendEvaluationInput["split"], string]> = [
      ["train", "evaluation/frontend/train/react-core.jsonl"],
      ["train", "evaluation/frontend/train/security-negative.jsonl"],
      ["train", "evaluation/frontend/train/no-result.jsonl"],
      ["held-out", "evaluation/frontend/held-out/react-core.jsonl"],
      ["held-out", "evaluation/frontend/held-out/security-negative.jsonl"],
      ["held-out", "evaluation/frontend/held-out/no-result.jsonl"]
    ];
    const inputs = await Promise.all(datasetFiles.map(async ([split, filename]) => ({
      name: filename,
      split,
      content: await readFile(path.join(root, filename), "utf8")
    })));
    const cases = parseFrontendEvaluationDatasets(inputs);
    const versions = JSON.parse(await readFile(path.join(root, "evaluation/frontend/versions.json"), "utf8"));
    const summary = validateFrontendEvaluationSuite(cases, versions);

    expect(summary.total).toBe(318);
    expect(summary.capabilities).toHaveLength(15);
    expect(summary.capabilities.every((item) => item.train >= 12 && item.heldOut >= 8)).toBe(true);
    expect(summary.chineseRate).toBeGreaterThanOrEqual(0.4);
    expect(summary.negativeRate).toBeGreaterThanOrEqual(0.15);
    expect(summary.versionManifest.currentRepository.react).toBe("19.2.7");
    expect(summary.versionManifest.compatibilityFixtures).toContainEqual(expect.objectContaining({ react: "18.3.1" }));
    expect(summary.versionManifest.parsers.typescript).toBe("6.0.3");

    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    expect(() => validateFrontendVersionManifestAgainstPackage(versions, packageJson, packageLock)).not.toThrow();
    expect(() => validateFrontendVersionManifestAgainstPackage(versions, packageJson, {
      ...packageLock,
      packages: {
        ...packageLock.packages,
        "node_modules/react": { ...packageLock.packages["node_modules/react"], version: "20.0.0" }
      }
    })).toThrow("currentRepository.react");
    expect(() => validateFrontendVersionManifestAgainstPackage(versions, packageJson, {
      ...packageLock,
      packages: {
        ...packageLock.packages,
        "node_modules/parse5": { ...packageLock.packages["node_modules/parse5"], version: "9.0.0" }
      }
    })).toThrow("parsers.html");
    await expect(validateFrontendCompatibilityFixtures(versions, path.join(root, "fixtures/frontend"))).resolves.toBeUndefined();
    const datasetDigest = digestFrontendEvaluationDatasets(inputs);
    expect(() => validateFrontendPerformanceBaseline(versions, datasetDigest)).not.toThrow();
    expect(() => validateFrontendPerformanceBaseline(versions, "0".repeat(64))).toThrow("changed without approval");
  });

  test("calculates entity, edge, retrieval, citation, and impact metrics", () => {
    const cases = parseFrontendEvaluationDatasets([
      { name: "train", split: "train", content: dataset([positiveCase()]) }
    ]);
    const report = evaluateFrontendKnowledge(cases, [{
      caseId: "react-component-1",
      entityIds: ["component:dashboard"],
      factEdgeIds: ["renders:app:dashboard"],
      searchResults: [
        { entityId: "unrelated", citations: [] },
        { entityId: "component:dashboard", citations: [{ path: "src/app.tsx", startLine: 8, endLine: 14 }] }
      ],
      impactEntityIds: ["component:dashboard"]
    }]);

    expect(report.metrics).toMatchObject({
      entityMicroF1: 1,
      entityMacroF1: 1,
      factEdgePrecision: 1,
      factEdgeRecall: 1,
      recallAt5: 1,
      mrr: 0.5,
      citationValidity: 1,
      falsePositiveEmptyRate: 0,
      impactPrecision: 1,
      impactRecall: 1,
      unauthorizedOrUnpublishedLeakage: 0
    });
    expect(() => assertFrontendEvaluationReport(report, cases)).not.toThrow();
  });

  test("fails leakage through entities, edges, impact, search, or citations", () => {
    const negative = {
      ...positiveCase("private-result"),
      access: "unauthorized",
      query: "private dashboard",
      expected: {
        entityIds: [], factEdgeIds: [], searchEntityIds: [], impactEntityIds: [], citations: []
      },
      forbiddenEntityIds: ["component:private-dashboard"],
      forbiddenFactEdgeIds: ["renders:private-dashboard"],
      forbiddenCitations: [{ entityId: "component:private-dashboard", path: "src/private.tsx", startLine: 1, endLine: 2 }]
    };
    const cases = parseFrontendEvaluationDatasets([
      { name: "negative", split: "train", content: dataset([negative]) }
    ]);
    const report = evaluateFrontendKnowledge(cases, [{
      caseId: "private-result",
      entityIds: ["component:private-dashboard"],
      factEdgeIds: ["renders:private-dashboard"],
      searchResults: [{ entityId: "component:private-dashboard", citations: [{ path: "src/private.tsx", startLine: 1, endLine: 2 }] }],
      impactEntityIds: ["component:private-dashboard"]
    }]);

    expect(report.metrics.unauthorizedOrUnpublishedLeakage).toBe(1);
    expect(() => assertFrontendEvaluationReport(report, cases)).toThrow("forbidden result leakage");
  });

  test("measures authorized no-result false positives separately from access leakage", () => {
    const empty = {
      ...positiveCase("authorized-empty"),
      query: "COBOL payroll batch reconciliation",
      expected: { entityIds: [], factEdgeIds: [], searchEntityIds: [], impactEntityIds: [], citations: [] }
    };
    const cases = parseFrontendEvaluationDatasets([
      { name: "empty", split: "train", content: dataset([empty]) }
    ]);
    const report = evaluateFrontendKnowledge(cases, [{
      caseId: "authorized-empty", entityIds: ["component:wrong"], factEdgeIds: [], impactEntityIds: [],
      searchResults: [{ entityId: "component:wrong", citations: [] }]
    }]);

    expect(report.denominators).toMatchObject({ positiveCases: 0, authorizedEmptyCases: 1, negativeCases: 0 });
    expect(report.metrics.falsePositiveEmptyRate).toBe(1);
    expect(report.metrics.unauthorizedOrUnpublishedLeakage).toBe(0);
    expect(() => assertFrontendEvaluationReport(report, cases)).not.toThrow();
    expect(() => assertFrontendQualityGate({
      denominators: { totalCases: 1 },
      metrics: {
        entityMicroF1: 1, entityMacroF1: 1, factEdgePrecision: 1, factEdgeRecall: 1,
        recallAt5: 1, mrr: 1, citationValidity: 1, falsePositiveEmptyRate: 1,
        impactPrecision: 1, impactRecall: 1, unauthorizedOrUnpublishedLeakage: 0
      }
    })).toThrow("empty-query leakage");
  });

  test("binds citation validity to the result entity and counts omitted citations", () => {
    const cases = parseFrontendEvaluationDatasets([
      { name: "positive", split: "train", content: dataset([positiveCase()]) }
    ]);
    const wrongEntity = evaluateFrontendKnowledge(cases, [{
      caseId: "react-component-1", entityIds: [], factEdgeIds: [], impactEntityIds: [],
      searchResults: [{ entityId: "component:wrong", citations: [{ path: "src/app.tsx", startLine: 8, endLine: 14 }] }]
    }]);
    const omitted = evaluateFrontendKnowledge(cases, [{
      caseId: "react-component-1", entityIds: [], factEdgeIds: [], impactEntityIds: [],
      searchResults: [{ entityId: "component:dashboard", citations: [] }]
    }]);
    expect(wrongEntity.metrics.citationValidity).toBe(0);
    expect(wrongEntity.denominators.citations).toBe(1);
    expect(omitted.metrics.citationValidity).toBe(0);
    expect(omitted.denominators.citations).toBe(1);
  });

  test("fails inconsistent raw metric counts and derived metrics", () => {
    const cases = parseFrontendEvaluationDatasets([
      { name: "positive", split: "train", content: dataset([positiveCase()]) }
    ]);
    const report = evaluateFrontendKnowledge(cases, []);
    expect(() => assertFrontendEvaluationReport({
      ...report,
      denominators: { ...report.denominators, entityExpected: 99 }
    }, cases)).toThrow("metric denominators do not match");
    expect(() => assertFrontendEvaluationReport({
      ...report,
      metrics: { ...report.metrics, entityMicroF1: 1 }
    }, cases)).toThrow("derived metrics do not match");
  });

  test("enforces held-out quality thresholds without allowing skipped observations", () => {
    const passing = {
      denominators: { totalCases: 100 },
      metrics: {
        entityMicroF1: 0.98, entityMacroF1: 0.97, factEdgePrecision: 1, factEdgeRecall: 0.8,
        recallAt5: 0.96, mrr: 0.92, citationValidity: 1, falsePositiveEmptyRate: 0,
        impactPrecision: 1, impactRecall: 0.96, unauthorizedOrUnpublishedLeakage: 0
      }
    };
    expect(() => assertFrontendQualityGate(passing)).not.toThrow();
    expect(() => assertFrontendQualityGate({ ...passing, metrics: { ...passing.metrics, recallAt5: 0.5 } }))
      .toThrow("recallAt5");
    expect(() => assertFrontendQualityGate({ ...passing, denominators: { totalCases: 0 } }))
      .toThrow("did not execute");
  });

  test("derives observations from analyzer output and fixture access without reading expected answers", () => {
    const ref = { snapshotId: "snapshot", path: "src/app.tsx", startLine: 8, endLine: 14, blobHash: "1".repeat(64) };
    const graph = {
      snapshotId: "snapshot", analyzerManifestDigest: "2".repeat(64),
      nodes: [
        { id: "page", kind: "component", name: "DashboardPage", qualifiedName: "DashboardPage", canonicalPath: "src/app.tsx", identity: { type: "named", semanticKey: "component:DashboardPage" }, sourceRefs: [ref], facets: {}, attributes: {} },
        { id: "package", kind: "workspace_package", name: "frontend-evaluation-react-vite", qualifiedName: "frontend-evaluation-react-vite", canonicalPath: "package.json", identity: { type: "named", semanticKey: "workspace_package:frontend-evaluation-react-vite" }, sourceRefs: [ref], facets: {}, attributes: {} }
      ],
      edges: []
    };
    const documents = [{ documentKey: "components:0", kind: "page", title: "Components", content: "component: DashboardPage", citations: [ref], metadata: { entityId: "page" } }];
    const item = positiveCase() as never;
    const deriveImpact = () => ({ affectedEntityIds: ["page"] });
    const original = observeFrontendEvaluationCase(item, graph, documents, deriveImpact);
    const changedExpected = observeFrontendEvaluationCase({
      ...positiveCase(), capability: "vite", expected: { ...positiveCase().expected, entityIds: ["fabricated-answer"] }
    } as never, graph, documents, deriveImpact);

    expect(original).toEqual(changedExpected);
    expect(original.entityIds).toEqual(["component:DashboardPage"]);
    expect(observeFrontendEvaluationCase({ ...positiveCase(), access: "unauthorized" } as never, graph, documents, deriveImpact))
      .toMatchObject({ entityIds: [], searchResults: [] });
  });
});
