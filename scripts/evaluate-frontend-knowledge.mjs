import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FRONTEND_CAPABILITIES = Object.freeze([
  "typescript-javascript",
  "jsx-tsx",
  "html",
  "css-modules",
  "sass-less",
  "workspace",
  "tsconfig",
  "react",
  "react-router",
  "zustand-context",
  "fetch-axios",
  "echarts",
  "unit-component-testing",
  "e2e-testing",
  "vite"
]);

const SPLITS = new Set(["train", "held-out"]);
const ACCESS = new Set(["authorized-published", "unauthorized", "unpublished"]);
const LOCALES = new Set(["en", "zh-CN"]);
const shaPattern = /^[a-f0-9]{64}$/u;

export function digestFrontendEvaluationDatasets(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Frontend evaluation datasets must not be empty");
  const digest = createHash("sha256");
  for (const input of inputs) {
    digest.update(`${String(input.name)}\0${String(input.split)}\0${String(input.content)}\0`, "utf8");
  }
  const value = digest.digest("hex");
  if (!shaPattern.test(value)) throw new Error("Frontend evaluation dataset digest is invalid");
  return value;
}

function object(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function nonEmptyString(value, field, id) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Frontend evaluation case ${id} has invalid ${field}`);
  return value.trim();
}

function stringArray(value, field, id) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Frontend evaluation case ${id} has invalid ${field}`);
  }
  return value.map((item) => item.trim());
}

function citations(value, id) {
  if (!Array.isArray(value)) throw new Error(`Frontend evaluation case ${id} has invalid citations`);
  return value.map((item) => {
    const citation = object(item, `Frontend evaluation case ${id} has invalid citation`);
    const entityId = nonEmptyString(citation.entityId, "citation entityId", id);
    const citationPath = nonEmptyString(citation.path, "citation path", id);
    if (!Number.isInteger(citation.startLine) || citation.startLine < 1
      || !Number.isInteger(citation.endLine) || citation.endLine < citation.startLine) {
      throw new Error(`Frontend evaluation case ${id} has invalid citation lines`);
    }
    return { entityId, path: citationPath, startLine: citation.startLine, endLine: citation.endLine };
  });
}

function parseCase(value, declaredSplit, line, datasetName) {
  const item = object(value, `Frontend evaluation ${datasetName} line ${line} must be an object`);
  const id = nonEmptyString(item.id, "id", `line-${line}`);
  const split = nonEmptyString(item.split, "split", id);
  const capability = nonEmptyString(item.capability, "capability", id);
  const access = nonEmptyString(item.access, "access", id);
  if (!SPLITS.has(split) || split !== declaredSplit) throw new Error(`Frontend evaluation case ${id} has invalid split`);
  if (!FRONTEND_CAPABILITIES.includes(capability)) throw new Error(`Frontend evaluation case ${id} has invalid capability`);
  if (!ACCESS.has(access)) throw new Error(`Frontend evaluation case ${id} has invalid access`);
  if (!LOCALES.has(item.locale)) throw new Error(`Frontend evaluation case ${id} has invalid locale`);
  if (item.source !== "fixture") throw new Error(`Frontend evaluation case ${id} has invalid source`);
  if (item.matchBy !== "stable-id") throw new Error(`Frontend evaluation case ${id} matchBy must be stable-id`);
  const expected = object(item.expected, `Frontend evaluation case ${id} has invalid expected result`);
  const parsedExpected = {
    entityIds: stringArray(expected.entityIds, "expected.entityIds", id),
    factEdgeIds: stringArray(expected.factEdgeIds, "expected.factEdgeIds", id),
    searchEntityIds: stringArray(expected.searchEntityIds, "expected.searchEntityIds", id),
    impactEntityIds: stringArray(expected.impactEntityIds, "expected.impactEntityIds", id),
    citations: citations(expected.citations, id)
  };
  const forbiddenEntityIds = stringArray(item.forbiddenEntityIds, "forbiddenEntityIds", id);
  const forbiddenFactEdgeIds = stringArray(item.forbiddenFactEdgeIds, "forbiddenFactEdgeIds", id);
  const forbiddenCitations = citations(item.forbiddenCitations, id);
  const negative = access !== "authorized-published";
  const expectedValues = [
    ...parsedExpected.entityIds,
    ...parsedExpected.factEdgeIds,
    ...parsedExpected.searchEntityIds,
    ...parsedExpected.impactEntityIds,
    ...parsedExpected.citations
  ];
  if (negative && (expectedValues.length || !forbiddenEntityIds.length || !forbiddenFactEdgeIds.length || !forbiddenCitations.length)) {
    throw new Error(`Frontend evaluation case ${id} negative access cases must expect no results and declare forbidden evidence`);
  }
  if (!negative && (!parsedExpected.entityIds.length || !parsedExpected.searchEntityIds.length)) {
    throw new Error(`Frontend evaluation case ${id} requires expected entities and search results`);
  }
  if (!negative && !parsedExpected.citations.length) {
    throw new Error(`Frontend evaluation case ${id} requires at least one citation`);
  }
  if (!negative && parsedExpected.citations.some((citation) => !parsedExpected.searchEntityIds.includes(citation.entityId))) {
    throw new Error(`Frontend evaluation case ${id} citations must bind to expected search entities`);
  }
  return {
    id,
    scenarioKey: nonEmptyString(item.scenarioKey, "scenarioKey", id),
    split,
    capability,
    locale: item.locale,
    source: item.source,
    access,
    query: nonEmptyString(item.query, "query", id),
    fixture: nonEmptyString(item.fixture, "fixture", id),
    matchBy: item.matchBy,
    expected: parsedExpected,
    forbiddenEntityIds,
    forbiddenFactEdgeIds,
    forbiddenCitations
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function answerFingerprint(item) {
  return createHash("sha256").update(stableJson({
    capability: item.capability,
    fixture: item.fixture,
    query: item.query.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US"),
    expected: item.expected,
    forbiddenEntityIds: item.forbiddenEntityIds,
    forbiddenFactEdgeIds: item.forbiddenFactEdgeIds,
    forbiddenCitations: item.forbiddenCitations
  })).digest("hex");
}

export function parseFrontendEvaluationDatasets(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Frontend evaluation datasets must not be empty");
  const cases = [];
  const ids = new Set();
  const scenarioSplits = new Map();
  const fingerprintSplits = new Map();
  for (const input of inputs) {
    if (!input || typeof input !== "object" || !SPLITS.has(input.split)) {
      throw new Error("Frontend evaluation dataset has invalid metadata");
    }
    const lines = String(input.content ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error(`Frontend evaluation dataset ${input.name} must not be empty`);
    for (let index = 0; index < lines.length; index += 1) {
      let parsed;
      try {
        parsed = JSON.parse(lines[index]);
      } catch (error) {
        throw new Error(`Frontend evaluation ${input.name} line ${index + 1} is not valid JSON`, { cause: error });
      }
      const item = parseCase(parsed, input.split, index + 1, input.name);
      if (ids.has(item.id)) throw new Error(`Frontend evaluation datasets have duplicate id: ${item.id}`);
      ids.add(item.id);
      const previousSplit = scenarioSplits.get(item.scenarioKey);
      if (previousSplit && previousSplit !== item.split) {
        throw new Error(`Frontend evaluation scenarioKey appears in both train and held-out: ${item.scenarioKey}`);
      }
      scenarioSplits.set(item.scenarioKey, item.split);
      const fingerprint = answerFingerprint(item);
      const previousFingerprintSplit = fingerprintSplits.get(fingerprint);
      if (previousFingerprintSplit && previousFingerprintSplit !== item.split) {
        throw new Error(`Frontend evaluation answer fingerprint appears in both train and held-out: ${item.id}`);
      }
      fingerprintSplits.set(fingerprint, item.split);
      cases.push(item);
    }
  }
  return cases;
}

export async function validateFrontendFixtureReferences(cases, fixturesRoot) {
  const root = path.resolve(fixturesRoot);
  for (const item of cases) {
    const fixtureRoot = path.resolve(root, item.fixture);
    if (fixtureRoot !== root && !fixtureRoot.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Frontend evaluation case ${item.id} fixture escapes fixture root`);
    }
    for (const citation of [...item.expected.citations, ...item.forbiddenCitations]) {
      const filename = path.resolve(fixtureRoot, citation.path);
      if (!filename.startsWith(`${fixtureRoot}${path.sep}`)) {
        throw new Error(`Frontend evaluation case ${item.id} citation escapes fixture root`);
      }
      let source;
      try {
        source = await readFile(filename, "utf8");
      } catch (error) {
        throw new Error(`Frontend evaluation case ${item.id} citation file is missing: ${citation.path}`, { cause: error });
      }
      const lineCount = source.split(/\r?\n/u).length;
      if (citation.endLine > lineCount) {
        throw new Error(`Frontend evaluation case ${item.id} citation is outside fixture line range: ${citation.path}`);
      }
    }
  }
}

function validateVersions(value) {
  const manifest = object(value, "Frontend version manifest must be an object");
  if (manifest.schemaVersion !== 1) throw new Error("Frontend version manifest has unsupported schemaVersion");
  const current = object(manifest.currentRepository, "Frontend version manifest requires currentRepository");
  for (const field of ["react", "reactDom", "vite", "typescript"]) nonEmptyString(current[field], `currentRepository.${field}`, "versions");
  if (!Array.isArray(manifest.compatibilityFixtures)
    || !manifest.compatibilityFixtures.some((item) => item?.react === "18.3.1" && item?.fixture === "react-vite")) {
    throw new Error("Frontend version manifest requires the approved React 18 compatibility fixture");
  }
  const parsers = object(manifest.parsers, "Frontend version manifest requires parsers");
  nonEmptyString(parsers.typescript, "parsers.typescript", "versions");
  const performance = object(manifest.performanceBaseline, "Frontend version manifest requires performanceBaseline");
  for (const field of ["runner", "cpu", "datasetDigestAlgorithm"]) nonEmptyString(performance[field], `performanceBaseline.${field}`, "versions");
  if (!Number.isInteger(performance.logicalCores) || performance.logicalCores < 1
    || !Number.isInteger(performance.memoryMiB) || performance.memoryMiB < 512) {
    throw new Error("Frontend version manifest has invalid performance baseline resources");
  }
  return manifest;
}

export function validateFrontendVersionManifestAgainstPackage(versionManifest, packageJson, packageLock) {
  const manifest = validateVersions(versionManifest);
  const packageData = object(packageJson, "Frontend evaluation requires package.json");
  const lockData = object(packageLock, "Frontend evaluation requires package-lock.json");
  const lockedPackages = object(lockData.packages, "Frontend evaluation package-lock.json requires packages");
  const expected = {
    react: "react",
    reactDom: "react-dom",
    vite: "vite",
    typescript: "typescript"
  };
  for (const [field, packageName] of Object.entries(expected)) {
    const declared = packageData.dependencies?.[packageName] ?? packageData.devDependencies?.[packageName];
    if (typeof declared !== "string") throw new Error(`Frontend evaluation package.json is missing ${packageName}`);
    const locked = lockedPackages[`node_modules/${packageName}`]?.version;
    if (typeof locked !== "string" || manifest.currentRepository[field] !== locked) {
      throw new Error(`Frontend version manifest currentRepository.${field} must match locked ${packageName} version`);
    }
  }
}

export async function validateFrontendCompatibilityFixtures(versionManifest, fixturesRoot) {
  const manifest = validateVersions(versionManifest);
  for (const fixture of manifest.compatibilityFixtures) {
    const filename = path.join(fixturesRoot, fixture.fixture, "package.json");
    const packageJson = JSON.parse(await readFile(filename, "utf8"));
    const actual = {
      react: packageJson.dependencies?.react,
      reactDom: packageJson.dependencies?.["react-dom"],
      vite: packageJson.devDependencies?.vite,
      typescript: packageJson.devDependencies?.typescript
    };
    for (const field of Object.keys(actual)) {
      if (actual[field] !== fixture[field]) {
        throw new Error(`Frontend compatibility fixture ${fixture.fixture}.${field} does not match package.json`);
      }
    }
  }
}

export function validateFrontendPerformanceBaseline(versionManifest, datasetDigest) {
  const performance = validateVersions(versionManifest).performanceBaseline;
  const expected = {
    runner: "github-actions-ubuntu-24.04-x64",
    cpu: "4-vcpu-x64",
    logicalCores: 4,
    memoryMiB: 16384,
    node: "22.13.0",
    dataset: "frontend-v1-core",
    datasetDigestAlgorithm: "sha256",
    datasetDigest
  };
  if (stableJson(performance) !== stableJson(expected)) {
    throw new Error("Frontend performance baseline or dataset digest changed without approval");
  }
}

export function validateFrontendEvaluationSuite(cases, versionManifest) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("Frontend evaluation suite must not be empty");
  const capabilities = FRONTEND_CAPABILITIES.map((capability) => {
    const scoped = cases.filter((item) => item.capability === capability);
    return {
      capability,
      train: scoped.filter((item) => item.split === "train").length,
      heldOut: scoped.filter((item) => item.split === "held-out").length
    };
  });
  const insufficient = capabilities.filter((item) => item.train < 12 || item.heldOut < 8);
  if (insufficient.length) throw new Error(`Frontend evaluation capability coverage is insufficient: ${insufficient.map((item) => item.capability).join(", ")}`);
  const chinese = cases.filter((item) => item.locale === "zh-CN").length;
  const negative = cases.filter((item) => item.access !== "authorized-published").length;
  const chineseRate = chinese / cases.length;
  const negativeRate = negative / cases.length;
  if (chineseRate < 0.4) throw new Error(`Frontend evaluation Chinese coverage ${chineseRate.toFixed(4)} is below 0.40`);
  if (negativeRate < 0.15) throw new Error(`Frontend evaluation negative coverage ${negativeRate.toFixed(4)} is below 0.15`);
  return {
    total: cases.length,
    chineseRate,
    negativeRate,
    capabilities,
    versionManifest: validateVersions(versionManifest)
  };
}

function setMetrics(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  let truePositive = 0;
  for (const value of actualSet) if (expectedSet.has(value)) truePositive += 1;
  return {
    truePositive,
    expected: expectedSet.size,
    actual: actualSet.size
  };
}

function precision(metric) {
  return metric.actual ? metric.truePositive / metric.actual : metric.expected ? 0 : 1;
}

function recall(metric) {
  return metric.expected ? metric.truePositive / metric.expected : metric.actual ? 0 : 1;
}

function f1(metric) {
  const p = precision(metric);
  const r = recall(metric);
  return p + r ? (2 * p * r) / (p + r) : 0;
}

function citationMatches(expected, entityId, actual) {
  return expected.some((citation) => citation.entityId === entityId && citation.path === actual.path
    && citation.startLine === actual.startLine
    && citation.endLine === actual.endLine);
}

export function evaluateFrontendKnowledge(cases, observations) {
  const observationByCase = new Map();
  for (const observation of observations) {
    if (observationByCase.has(observation.caseId)) throw new Error(`Duplicate frontend observation: ${observation.caseId}`);
    observationByCase.set(observation.caseId, observation);
  }
  const unknown = [...observationByCase.keys()].filter((id) => !cases.some((item) => item.id === id));
  if (unknown.length) throw new Error(`Unknown frontend observations: ${unknown.join(", ")}`);

  const entity = { truePositive: 0, expected: 0, actual: 0 };
  const edge = { truePositive: 0, expected: 0, actual: 0 };
  const impact = { truePositive: 0, expected: 0, actual: 0 };
  const capabilityEntities = new Map(FRONTEND_CAPABILITIES.map((item) => [item, { truePositive: 0, expected: 0, actual: 0 }]));
  let searchCases = 0;
  let recalled = 0;
  let reciprocalRanks = 0;
  let citationsSeen = 0;
  let validCitations = 0;
  let negativeCases = 0;
  let falsePositiveEmpty = 0;
  let leakage = 0;
  const failures = [];

  for (const item of cases) {
    const observation = observationByCase.get(item.id) ?? {
      caseId: item.id, entityIds: [], factEdgeIds: [], searchResults: [], impactEntityIds: []
    };
    const entityMetric = setMetrics(item.expected.entityIds, observation.entityIds ?? []);
    const edgeMetric = setMetrics(item.expected.factEdgeIds, observation.factEdgeIds ?? []);
    const impactMetric = setMetrics(item.expected.impactEntityIds, observation.impactEntityIds ?? []);
    for (const key of ["truePositive", "expected", "actual"]) {
      entity[key] += entityMetric[key];
      edge[key] += edgeMetric[key];
      impact[key] += impactMetric[key];
      capabilityEntities.get(item.capability)[key] += entityMetric[key];
    }
    const results = observation.searchResults ?? [];
    if (item.access !== "authorized-published") {
      negativeCases += 1;
      const returnedAnything = (observation.entityIds?.length ?? 0) > 0
        || (observation.factEdgeIds?.length ?? 0) > 0
        || (observation.impactEntityIds?.length ?? 0) > 0
        || results.length > 0
        || results.some((result) => (result.citations?.length ?? 0) > 0);
      if (returnedAnything) {
        falsePositiveEmpty += 1;
        leakage += 1;
      }
      continue;
    }
    searchCases += 1;
    const rank = results.findIndex((result) => item.expected.searchEntityIds.includes(result.entityId));
    if (rank >= 0 && rank < 5) recalled += 1;
    else failures.push({ caseId: item.id, kind: "expected-search-result-missing" });
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
    for (const result of results.slice(0, 5)) {
      if (!item.expected.searchEntityIds.includes(result.entityId)) continue;
      const resultCitations = result.citations ?? [];
      if (!resultCitations.length) citationsSeen += 1;
      for (const citation of resultCitations) {
        citationsSeen += 1;
        if (citationMatches(item.expected.citations, result.entityId, citation)) validCitations += 1;
        else failures.push({ caseId: item.id, kind: "invalid-citation" });
      }
    }
  }

  const activeCapabilityMetrics = [...capabilityEntities.values()].filter((metric) => metric.expected || metric.actual);
  const positiveCases = cases.length - negativeCases;
  const rawCounts = {
    entity,
    edge,
    impact,
    capabilityEntities: Object.fromEntries(capabilityEntities),
    search: { cases: searchCases, recalled, reciprocalRanks },
    citations: { checked: citationsSeen, valid: validCitations },
    negative: { cases: negativeCases, falsePositive: falsePositiveEmpty, leakageCases: leakage }
  };
  return {
    protocolVersion: 1,
    caseIds: cases.map((item) => item.id),
    denominators: {
      totalCases: cases.length,
      positiveCases,
      negativeCases,
      capabilities: new Set(cases.map((item) => item.capability)).size,
      entityExpected: entity.expected,
      entityPredicted: entity.actual,
      edgeExpected: edge.expected,
      edgePredicted: edge.actual,
      searchCases,
      citations: citationsSeen,
      impactExpected: impact.expected,
      impactPredicted: impact.actual
    },
    metrics: {
      entityMicroF1: f1(entity),
      entityMacroF1: activeCapabilityMetrics.length
        ? activeCapabilityMetrics.reduce((sum, metric) => sum + f1(metric), 0) / activeCapabilityMetrics.length : 0,
      factEdgePrecision: precision(edge),
      factEdgeRecall: recall(edge),
      recallAt5: searchCases ? recalled / searchCases : 0,
      mrr: searchCases ? reciprocalRanks / searchCases : 0,
      citationValidity: citationsSeen ? validCitations / citationsSeen : 0,
      falsePositiveEmptyRate: negativeCases ? falsePositiveEmpty / negativeCases : 0,
      impactPrecision: precision(impact),
      impactRecall: recall(impact),
      unauthorizedOrUnpublishedLeakage: leakage
    },
    rawCounts,
    failures
  };
}

function close(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-12;
}

export function assertFrontendEvaluationReport(report, cases) {
  const positiveCases = cases.filter((item) => item.access === "authorized-published").length;
  const expectedDenominators = {
    totalCases: cases.length,
    positiveCases,
    negativeCases: cases.length - positiveCases,
    capabilities: new Set(cases.map((item) => item.capability)).size,
    entityExpected: cases.reduce((sum, item) => sum + item.expected.entityIds.length, 0),
    edgeExpected: cases.reduce((sum, item) => sum + item.expected.factEdgeIds.length, 0),
    searchCases: positiveCases,
    impactExpected: cases.reduce((sum, item) => sum + item.expected.impactEntityIds.length, 0)
  };
  if (Object.entries(expectedDenominators).some(([key, value]) => report.denominators?.[key] !== value)
    || report.caseIds?.length !== cases.length
    || new Set(report.caseIds ?? []).size !== cases.length) {
    throw new Error("Frontend evaluation metric denominators do not match the dataset");
  }
  const raw = report.rawCounts;
  if (!raw
    || report.denominators.entityExpected !== raw.entity.expected
    || report.denominators.entityPredicted !== raw.entity.actual
    || report.denominators.edgeExpected !== raw.edge.expected
    || report.denominators.edgePredicted !== raw.edge.actual
    || report.denominators.searchCases !== raw.search.cases
    || report.denominators.citations !== raw.citations.checked
    || report.denominators.impactExpected !== raw.impact.expected
    || report.denominators.impactPredicted !== raw.impact.actual) {
    throw new Error("Frontend evaluation metric denominators do not match raw counts");
  }
  const capabilityMetrics = Object.values(raw.capabilityEntities).filter((metric) => metric.expected || metric.actual);
  const derived = {
    entityMicroF1: f1(raw.entity),
    entityMacroF1: capabilityMetrics.length ? capabilityMetrics.reduce((sum, metric) => sum + f1(metric), 0) / capabilityMetrics.length : 0,
    factEdgePrecision: precision(raw.edge),
    factEdgeRecall: recall(raw.edge),
    recallAt5: raw.search.cases ? raw.search.recalled / raw.search.cases : 0,
    mrr: raw.search.cases ? raw.search.reciprocalRanks / raw.search.cases : 0,
    citationValidity: raw.citations.checked ? raw.citations.valid / raw.citations.checked : 0,
    falsePositiveEmptyRate: raw.negative.cases ? raw.negative.falsePositive / raw.negative.cases : 0,
    impactPrecision: precision(raw.impact),
    impactRecall: recall(raw.impact),
    unauthorizedOrUnpublishedLeakage: raw.negative.leakageCases
  };
  if (Object.entries(derived).some(([key, value]) => !close(report.metrics[key], value))) {
    throw new Error("Frontend evaluation derived metrics do not match raw counts");
  }
  if (report.metrics.unauthorizedOrUnpublishedLeakage > 0) {
    throw new Error("Frontend evaluation found forbidden result leakage");
  }
}

async function loadDataset(root, filename, split) {
  return { name: filename, split, content: await readFile(path.join(root, filename), "utf8") };
}

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = await Promise.all([
    loadDataset(root, "evaluation/frontend/train/react-core.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/train/security-negative.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/held-out/react-core.jsonl", "held-out"),
    loadDataset(root, "evaluation/frontend/held-out/security-negative.jsonl", "held-out")
  ]);
  const cases = parseFrontendEvaluationDatasets(inputs);
  const datasetDigest = digestFrontendEvaluationDatasets(inputs);
  await validateFrontendFixtureReferences(cases, path.join(root, "fixtures/frontend"));
  const versions = JSON.parse(await readFile(path.join(root, "evaluation/frontend/versions.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  validateFrontendVersionManifestAgainstPackage(versions, packageJson, packageLock);
  await validateFrontendCompatibilityFixtures(versions, path.join(root, "fixtures/frontend"));
  validateFrontendPerformanceBaseline(versions, datasetDigest);
  const suite = validateFrontendEvaluationSuite(cases, versions);
  const report = evaluateFrontendKnowledge(cases, []);
  const output = {
    dataset: "frontend-v1-core",
    datasetDigest,
    status: "protocol-baseline-no-analyzer",
    qualityGateEnforced: false,
    generatedFromCommittedFixtures: true,
    suite,
    report
  };
  const outputPath = path.join(root, "artifacts/frontend-knowledge-evaluation.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    dataset: output.dataset,
    datasetDigest: output.datasetDigest,
    status: output.status,
    qualityGateEnforced: output.qualityGateEnforced,
    totalCases: output.suite.total,
    chineseRate: output.suite.chineseRate,
    negativeRate: output.suite.negativeRate,
    report: path.relative(root, outputPath)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
