import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertFrontendEvaluationReport,
  digestFrontendEvaluationDatasets,
  evaluateFrontendKnowledge,
  parseFrontendEvaluationDatasets,
  type FrontendEvaluationInput,
  validateFrontendEvaluationSuite,
  validateFrontendFixtureReferences,
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
      citations: [{ path: "src/app.tsx", startLine: 8, endLine: 14 }]
    },
    forbiddenEntityIds: []
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

  test("rejects train and held-out scenario reuse", () => {
    const heldOut = {
      ...positiveCase("held-out-case"),
      scenarioKey: positiveCase().scenarioKey,
      split: "held-out"
    };
    expect(() => parseFrontendEvaluationDatasets([
      { name: "train", split: "train", content: dataset([positiveCase()]) },
      { name: "held-out", split: "held-out", content: dataset([heldOut]) }
    ])).toThrow("scenarioKey appears in both train and held-out");
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
      expected: { ...valid.expected, citations: [{ path: "../secret", startLine: 1, endLine: 1 }] }
    }], path.join(root, "fixtures/frontend"))).rejects.toThrow("escapes fixture root");
    await expect(validateFrontendFixtureReferences([{
      ...valid,
      expected: { ...valid.expected, citations: [{ path: "src/app.tsx", startLine: 1, endLine: 999 }] }
    }], path.join(root, "fixtures/frontend"))).rejects.toThrow("outside fixture line range");
  });

  test("ships the approved per-capability distribution and locked version manifest", async () => {
    const datasetFiles: Array<[string, FrontendEvaluationInput["split"], string]> = [
      ["react-core-train", "train", "evaluation/frontend/train/react-core.jsonl"],
      ["security-train", "train", "evaluation/frontend/train/security-negative.jsonl"],
      ["react-core-held-out", "held-out", "evaluation/frontend/held-out/react-core.jsonl"],
      ["security-held-out", "held-out", "evaluation/frontend/held-out/security-negative.jsonl"]
    ];
    const inputs = await Promise.all(datasetFiles.map(async ([name, split, filename]) => ({
      name,
      split,
      content: await readFile(path.join(root, filename), "utf8")
    })));
    const cases = parseFrontendEvaluationDatasets(inputs);
    const versions = JSON.parse(await readFile(path.join(root, "evaluation/frontend/versions.json"), "utf8"));
    const summary = validateFrontendEvaluationSuite(cases, versions);

    expect(summary.total).toBe(300);
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

  test("fails leakage and inconsistent metric denominators", () => {
    const negative = {
      ...positiveCase("private-result"),
      access: "unauthorized",
      query: "private dashboard",
      expected: {
        entityIds: [], factEdgeIds: [], searchEntityIds: [], impactEntityIds: [], citations: []
      },
      forbiddenEntityIds: ["component:private-dashboard"]
    };
    const cases = parseFrontendEvaluationDatasets([
      { name: "negative", split: "train", content: dataset([negative]) }
    ]);
    const report = evaluateFrontendKnowledge(cases, [{
      caseId: "private-result",
      entityIds: [],
      factEdgeIds: [],
      searchResults: [{ entityId: "component:private-dashboard", citations: [] }],
      impactEntityIds: []
    }]);

    expect(report.metrics.unauthorizedOrUnpublishedLeakage).toBe(1);
    expect(() => assertFrontendEvaluationReport(report, cases)).toThrow("forbidden result leakage");
    expect(() => assertFrontendEvaluationReport({
      ...report,
      denominators: { ...report.denominators, totalCases: 99 }
    }, cases)).toThrow("metric denominators do not match");
  });
});
