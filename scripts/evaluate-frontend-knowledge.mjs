import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateFrontendKnowledge } from "../src/server/knowledge/frontend/knowledge-generator.ts";
import { buildFrontendSearchDocuments, searchFrontendKnowledge } from "../src/server/knowledge/frontend/search.ts";

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
export const FRONTEND_TRIAL_CAPABILITIES = Object.freeze([
  "redux-toolkit",
  "tanstack-query",
  "openapi-graphql",
  "complex-form-validation",
  "permission-guards",
  "storybook",
  "design-system"
]);
const FRONTEND_SECONDARY_CAPABILITIES = Object.freeze([
  "webpack-rspack-rollup",
  "nx-turbo",
  "i18n",
  "accessibility",
  "error-monitoring",
  "web-vitals"
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
  const trialCapability = item.trialCapability === undefined
    ? null
    : nonEmptyString(item.trialCapability, "trialCapability", id);
  const access = nonEmptyString(item.access, "access", id);
  if (!SPLITS.has(split) || split !== declaredSplit) throw new Error(`Frontend evaluation case ${id} has invalid split`);
  if (!FRONTEND_CAPABILITIES.includes(capability)) throw new Error(`Frontend evaluation case ${id} has invalid capability`);
  if (trialCapability && !FRONTEND_TRIAL_CAPABILITIES.includes(trialCapability)) {
    throw new Error(`Frontend evaluation case ${id} has invalid trialCapability`);
  }
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
  const authorizedEmpty = !negative && parsedExpected.searchEntityIds.length === 0;
  if (authorizedEmpty && expectedValues.length) {
    throw new Error(`Frontend evaluation case ${id} authorized empty cases must expect no results`);
  }
  if (!negative && !authorizedEmpty && (!parsedExpected.entityIds.length || !parsedExpected.searchEntityIds.length)) {
    throw new Error(`Frontend evaluation case ${id} requires expected entities and search results`);
  }
  if (!negative && !authorizedEmpty && !parsedExpected.citations.length) {
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
    ...(trialCapability ? { trialCapability } : {}),
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
  const fixtureSplits = new Map();
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
      const previousFixtureSplit = fixtureSplits.get(item.fixture);
      if (previousFixtureSplit && previousFixtureSplit !== item.split) {
        throw new Error(`Frontend evaluation fixture appears in both train and held-out: ${item.fixture}`);
      }
      fixtureSplits.set(item.fixture, item.split);
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

export const FRONTEND_EXPERIENCE_CAPABILITIES = Object.freeze([
  "react-routing",
  "state-api",
  "forms-auth",
  "charts",
  "impact-testing"
]);

const EXPERIENCE_DECISIONS = new Set(["recommend", "reject", "abstain", "no_result"]);
const EXPERIENCE_SOURCE_ELIGIBILITY = new Set(["git", "git_linked", "admin_attested", "unverified_upload"]);
const EXPERIENCE_LIFECYCLES = new Set(["verified", "recommended", "standard", "deprecated"]);
const EXPERIENCE_EVIDENCE_STATES = new Set(["active", "revoked"]);
const EXPERIENCE_RECOMMENDABLE_LIFECYCLES = new Set(["recommended", "standard"]);
const EXPERIENCE_ELIGIBLE_SOURCES = new Set(["git", "git_linked", "admin_attested"]);

function parseExperienceConditions(value, field, id) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Frontend experience case ${id} has invalid ${field}`);
  return value.map((raw) => {
    const item = object(raw, `Frontend experience case ${id} has invalid ${field}`);
    return {
      key: nonEmptyString(item.key, `${field}.key`, id),
      value: nonEmptyString(item.value, `${field}.value`, id)
    };
  });
}

function parseExperienceCandidate(value, id) {
  const item = object(value, `Frontend experience case ${id} has invalid candidate`);
  const candidate = {
    id: nonEmptyString(item.id, "candidate.id", id),
    sourceProjectId: nonEmptyString(item.sourceProjectId, "candidate.sourceProjectId", id),
    releaseId: nonEmptyString(item.releaseId, "candidate.releaseId", id),
    evidenceId: nonEmptyString(item.evidenceId, "candidate.evidenceId", id),
    sourceEligibility: nonEmptyString(item.sourceEligibility, "candidate.sourceEligibility", id),
    lifecycle: nonEmptyString(item.lifecycle, "candidate.lifecycle", id),
    evidenceState: nonEmptyString(item.evidenceState, "candidate.evidenceState", id),
    required: parseExperienceConditions(item.required, "candidate.required", id),
    forbidden: parseExperienceConditions(item.forbidden, "candidate.forbidden", id)
  };
  if (!EXPERIENCE_SOURCE_ELIGIBILITY.has(candidate.sourceEligibility)) {
    throw new Error(`Frontend experience case ${id} has invalid candidate.sourceEligibility`);
  }
  if (!EXPERIENCE_LIFECYCLES.has(candidate.lifecycle)) {
    throw new Error(`Frontend experience case ${id} has invalid candidate.lifecycle`);
  }
  if (!EXPERIENCE_EVIDENCE_STATES.has(candidate.evidenceState)) {
    throw new Error(`Frontend experience case ${id} has invalid candidate.evidenceState`);
  }
  return candidate;
}

function parseExperienceCase(value, declaredSplit, line, datasetName) {
  const item = object(value, `Frontend experience ${datasetName} line ${line} must be an object`);
  const id = nonEmptyString(item.id, "id", `line-${line}`);
  const split = nonEmptyString(item.split, "split", id);
  const capability = nonEmptyString(item.capability, "capability", id);
  if (!SPLITS.has(split) || split !== declaredSplit) throw new Error(`Frontend experience case ${id} has invalid split`);
  if (!FRONTEND_EXPERIENCE_CAPABILITIES.includes(capability)) {
    throw new Error(`Frontend experience case ${id} has invalid capability`);
  }
  if (!LOCALES.has(item.locale)) throw new Error(`Frontend experience case ${id} has invalid locale`);
  const profile = object(item.currentProjectProfile, `Frontend experience case ${id} has invalid currentProjectProfile`);
  if (Object.values(profile).some((profileValue) => typeof profileValue !== "string" || !profileValue.trim())) {
    throw new Error(`Frontend experience case ${id} has invalid currentProjectProfile value`);
  }
  if (!Array.isArray(item.candidates)) throw new Error(`Frontend experience case ${id} has invalid candidates`);
  const candidates = item.candidates.map((candidate) => parseExperienceCandidate(candidate, id));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error(`Frontend experience case ${id} has duplicate candidate id`);
  }
  const expectedDecision = nonEmptyString(item.expectedDecision, "expectedDecision", id);
  if (!EXPERIENCE_DECISIONS.has(expectedDecision)) {
    throw new Error(`Frontend experience case ${id} has invalid expectedDecision`);
  }
  const parsed = {
    id,
    split,
    capability,
    locale: item.locale,
    query: nonEmptyString(item.query, "query", id),
    currentProjectId: nonEmptyString(item.currentProjectId, "currentProjectId", id),
    currentProjectProfile: Object.fromEntries(Object.entries(profile).map(([key, profileValue]) => [key, profileValue.trim()])),
    visibleReleaseIds: stringArray(item.visibleReleaseIds, "visibleReleaseIds", id),
    visibleEvidenceIds: stringArray(item.visibleEvidenceIds, "visibleEvidenceIds", id),
    invisibleEvidenceIds: stringArray(item.invisibleEvidenceIds, "invisibleEvidenceIds", id),
    candidates,
    expectedDecision,
    expectedRecommendationIds: stringArray(item.expectedRecommendationIds, "expectedRecommendationIds", id),
    expectedRejectionReasons: stringArray(item.expectedRejectionReasons, "expectedRejectionReasons", id),
    expectedUnknownKeys: stringArray(item.expectedUnknownKeys, "expectedUnknownKeys", id),
    abstentionRequired: item.abstentionRequired
  };
  if (typeof parsed.abstentionRequired !== "boolean") {
    throw new Error(`Frontend experience case ${id} has invalid abstentionRequired`);
  }
  if (parsed.expectedDecision === "recommend" && !parsed.expectedRecommendationIds.length) {
    throw new Error(`Frontend experience case ${id} recommendation requires expectedRecommendationIds`);
  }
  if (parsed.expectedDecision === "no_result" && candidates.length) {
    throw new Error(`Frontend experience case ${id} no_result must not declare candidates`);
  }
  if (parsed.abstentionRequired !== (parsed.expectedDecision === "abstain")) {
    throw new Error(`Frontend experience case ${id} abstentionRequired must match expectedDecision`);
  }
  return parsed;
}

export function parseFrontendExperienceEvaluationDatasets(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Frontend experience evaluation datasets must not be empty");
  const cases = [];
  const ids = new Set();
  for (const input of inputs) {
    if (!input || typeof input !== "object" || !SPLITS.has(input.split)) {
      throw new Error("Frontend experience evaluation dataset has invalid metadata");
    }
    const lines = String(input.content ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error(`Frontend experience evaluation dataset ${input.name} must not be empty`);
    for (let index = 0; index < lines.length; index += 1) {
      let value;
      try {
        value = JSON.parse(lines[index]);
      } catch (error) {
        throw new Error(`Frontend experience ${input.name} line ${index + 1} is not valid JSON`, { cause: error });
      }
      const item = parseExperienceCase(value, input.split, index + 1, input.name);
      if (ids.has(item.id)) throw new Error(`Frontend experience evaluation datasets have duplicate id: ${item.id}`);
      ids.add(item.id);
      cases.push(item);
    }
  }
  return cases;
}

function frontendExperienceNegativeKinds(item) {
  const reasons = new Set(item.expectedRejectionReasons);
  const kinds = [];
  if (reasons.has("REQUIRED_CONDITION_MISMATCH") || reasons.has("FORBIDDEN_CONDITION_MATCH")) kinds.push("hard-conflict");
  if (reasons.has("REQUIRED_CONDITION_UNKNOWN")) kinds.push("required-unknown");
  if (item.expectedDecision === "no_result") kinds.push("no-result");
  if (reasons.has("SOURCE_INELIGIBLE")) kinds.push("source-ineligible");
  if (reasons.has("RELEASE_NOT_VISIBLE") || reasons.has("EVIDENCE_NOT_VISIBLE")) kinds.push("unauthorized");
  if (reasons.has("EVIDENCE_REVOKED")) kinds.push("revoked");
  return kinds;
}

export function validateFrontendExperienceEvaluationSuite(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("Frontend experience evaluation suite must not be empty");
  const capabilities = FRONTEND_EXPERIENCE_CAPABILITIES.map((capability) => {
    const scoped = cases.filter((item) => item.capability === capability);
    return {
      capability,
      train: scoped.filter((item) => item.split === "train").length,
      heldOut: scoped.filter((item) => item.split === "held-out").length
    };
  });
  const insufficient = capabilities.filter((item) => item.train < 12 || item.heldOut < 8);
  if (insufficient.length) {
    throw new Error(`Frontend experience capability coverage is insufficient: ${insufficient.map((item) => item.capability).join(", ")}`);
  }
  const chineseRate = cases.filter((item) => item.locale === "zh-CN").length / cases.length;
  const negativeRate = cases.filter((item) => item.expectedDecision !== "recommend").length / cases.length;
  if (chineseRate < 0.4) throw new Error(`Frontend experience Chinese coverage ${chineseRate.toFixed(4)} is below 0.40`);
  if (negativeRate < 0.25) throw new Error(`Frontend experience negative coverage ${negativeRate.toFixed(4)} is below 0.25`);
  const negativeKinds = [...new Set(cases.flatMap(frontendExperienceNegativeKinds))].sort();
  const requiredKinds = ["hard-conflict", "required-unknown", "no-result", "source-ineligible", "unauthorized", "revoked"];
  for (const split of SPLITS) {
    const splitKinds = new Set(cases.filter((item) => item.split === split).flatMap(frontendExperienceNegativeKinds));
    const missing = requiredKinds.filter((kind) => !splitKinds.has(kind));
    if (missing.length) throw new Error(`Frontend experience ${split} is missing negative kinds: ${missing.join(", ")}`);
  }
  return { total: cases.length, chineseRate, negativeRate, capabilities, negativeKinds };
}

function decideFrontendExperienceCase(item) {
  const recommendations = [];
  const rejected = [];
  const unknownKeys = new Set();
  const reject = (candidate, reason, unknownKey = null) => {
    rejected.push({ candidateId: candidate.id, reason, ...(unknownKey ? { unknownKey } : {}) });
    if (unknownKey) unknownKeys.add(unknownKey);
  };
  for (const candidate of item.candidates) {
    if (candidate.sourceProjectId === item.currentProjectId) {
      reject(candidate, "CURRENT_PROJECT_EXCLUDED");
      continue;
    }
    if (!item.visibleReleaseIds.includes(candidate.releaseId)) {
      reject(candidate, "RELEASE_NOT_VISIBLE");
      continue;
    }
    if (!item.visibleEvidenceIds.includes(candidate.evidenceId)) {
      reject(candidate, "EVIDENCE_NOT_VISIBLE");
      continue;
    }
    if (!EXPERIENCE_ELIGIBLE_SOURCES.has(candidate.sourceEligibility)) {
      reject(candidate, "SOURCE_INELIGIBLE");
      continue;
    }
    if (!EXPERIENCE_RECOMMENDABLE_LIFECYCLES.has(candidate.lifecycle)) {
      reject(candidate, "LIFECYCLE_INELIGIBLE");
      continue;
    }
    if (candidate.evidenceState === "revoked") {
      reject(candidate, "EVIDENCE_REVOKED");
      continue;
    }
    const unknownRequired = candidate.required.find((condition) => item.currentProjectProfile[condition.key] === undefined);
    if (unknownRequired) {
      reject(candidate, "REQUIRED_CONDITION_UNKNOWN", unknownRequired.key);
      continue;
    }
    if (candidate.required.some((condition) => item.currentProjectProfile[condition.key] !== condition.value)) {
      reject(candidate, "REQUIRED_CONDITION_MISMATCH");
      continue;
    }
    if (candidate.forbidden.some((condition) => item.currentProjectProfile[condition.key] === condition.value)) {
      reject(candidate, "FORBIDDEN_CONDITION_MATCH");
      continue;
    }
    recommendations.push(candidate.id);
  }
  const decision = recommendations.length
    ? "recommend"
    : item.candidates.length === 0
      ? "no_result"
      : unknownKeys.size
        ? "abstain"
        : "reject";
  return {
    caseId: item.id,
    decision,
    recommendationIds: recommendations,
    rejected,
    unknownKeys: [...unknownKeys].sort()
  };
}

function sameStrings(left, right) {
  return stableJson([...new Set(left)].sort()) === stableJson([...new Set(right)].sort());
}

export function evaluateFrontendExperience(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("Frontend experience evaluation requires cases");
  const observations = cases.map(decideFrontendExperienceCase);
  let expectedRecommendations = 0;
  let predictedRecommendations = 0;
  let trueRecommendations = 0;
  let hardConflictCases = 0;
  let hardConflictRecommendations = 0;
  let revokedCases = 0;
  let revokedRecommendations = 0;
  let unknownCases = 0;
  let unknownAbstentions = 0;
  let currentProjectRecommendations = 0;
  let unauthorizedCases = 0;
  let unauthorizedRecommendations = 0;
  let sourceCandidates = 0;
  let sourceCorrect = 0;
  let validPartitions = 0;
  let matchingContracts = 0;
  const failures = [];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const observation = observations[index];
    const expected = new Set(item.expectedRecommendationIds);
    expectedRecommendations += expected.size;
    predictedRecommendations += observation.recommendationIds.length;
    trueRecommendations += observation.recommendationIds.filter((id) => expected.has(id)).length;
    const expectedReasons = new Set(item.expectedRejectionReasons);
    const actualReasons = observation.rejected.map((entry) => entry.reason);
    const hardConflict = expectedReasons.has("REQUIRED_CONDITION_MISMATCH") || expectedReasons.has("FORBIDDEN_CONDITION_MATCH");
    if (hardConflict) {
      hardConflictCases += 1;
      if (observation.recommendationIds.length) hardConflictRecommendations += 1;
    }
    if (expectedReasons.has("EVIDENCE_REVOKED")) {
      revokedCases += 1;
      if (observation.recommendationIds.length) revokedRecommendations += 1;
    }
    if (item.abstentionRequired) {
      unknownCases += 1;
      if (observation.decision === "abstain" && sameStrings(observation.unknownKeys, item.expectedUnknownKeys)) unknownAbstentions += 1;
    }
    currentProjectRecommendations += observation.recommendationIds.filter((id) => item.candidates.some(
      (candidate) => candidate.id === id && candidate.sourceProjectId === item.currentProjectId
    )).length;
    const unauthorized = item.candidates.some((candidate) => !item.visibleReleaseIds.includes(candidate.releaseId)
      || !item.visibleEvidenceIds.includes(candidate.evidenceId));
    if (unauthorized) {
      unauthorizedCases += 1;
      if (observation.recommendationIds.length) unauthorizedRecommendations += 1;
    }
    for (const candidate of item.candidates) {
      sourceCandidates += 1;
      const expectedEligible = EXPERIENCE_ELIGIBLE_SOURCES.has(candidate.sourceEligibility);
      const actualSourceRejected = observation.rejected.some((entry) => entry.candidateId === candidate.id && entry.reason === "SOURCE_INELIGIBLE");
      if (expectedEligible !== actualSourceRejected) sourceCorrect += 1;
    }
    const partitionIds = [...observation.recommendationIds, ...observation.rejected.map((entry) => entry.candidateId)];
    if (partitionIds.length === item.candidates.length && new Set(partitionIds).size === item.candidates.length) validPartitions += 1;
    const matches = observation.decision === item.expectedDecision
      && sameStrings(observation.recommendationIds, item.expectedRecommendationIds)
      && sameStrings(actualReasons, item.expectedRejectionReasons)
      && sameStrings(observation.unknownKeys, item.expectedUnknownKeys);
    if (matches) matchingContracts += 1;
    else failures.push({ caseId: item.id, expectedDecision: item.expectedDecision, observation });
  }
  return {
    protocolVersion: 1,
    caseIds: cases.map((item) => item.id),
    observations,
    denominators: {
      totalCases: cases.length,
      expectedRecommendations,
      predictedRecommendations,
      hardConflictCases,
      revokedCases,
      unknownCases,
      unauthorizedCases,
      sourceCandidates
    },
    metrics: {
      sourceProvenanceAccuracy: sourceCandidates ? sourceCorrect / sourceCandidates : 1,
      hardConflictRecommendationRate: hardConflictCases ? hardConflictRecommendations / hardConflictCases : 0,
      revokedEvidenceRecommendationRate: revokedCases ? revokedRecommendations / revokedCases : 0,
      recommendationApplicabilityPrecision: predictedRecommendations ? trueRecommendations / predictedRecommendations : 1,
      requiredUnknownAbstentionRecall: unknownCases ? unknownAbstentions / unknownCases : 1,
      currentProjectPriorLeakRate: currentProjectRecommendations,
      unauthorizedEvidenceRecommendationRate: unauthorizedCases ? unauthorizedRecommendations / unauthorizedCases : 0,
      responsePartitionValidity: validPartitions / cases.length,
      expectedContractMatchRate: matchingContracts / cases.length
    },
    failures
  };
}

export function evaluateFrontendExperienceBySplit(cases) {
  return {
    train: evaluateFrontendExperience(cases.filter((item) => item.split === "train")),
    heldOut: evaluateFrontendExperience(cases.filter((item) => item.split === "held-out")),
    all: evaluateFrontendExperience(cases)
  };
}

export function assertFrontendExperienceQualityGate(report) {
  if (!report?.denominators?.totalCases) throw new Error("Frontend experience quality gate did not execute cases");
  const minimums = {
    sourceProvenanceAccuracy: 1,
    recommendationApplicabilityPrecision: 0.95,
    requiredUnknownAbstentionRecall: 0.95,
    responsePartitionValidity: 1,
    expectedContractMatchRate: 1
  };
  for (const [metric, minimum] of Object.entries(minimums)) {
    if (!Number.isFinite(report.metrics?.[metric]) || report.metrics[metric] < minimum) {
      throw new Error(`Frontend experience quality gate ${metric} ${report.metrics?.[metric] ?? "missing"} is below ${minimum}`);
    }
  }
  for (const metric of [
    "hardConflictRecommendationRate",
    "revokedEvidenceRecommendationRate",
    "currentProjectPriorLeakRate",
    "unauthorizedEvidenceRecommendationRate"
  ]) {
    if (report.metrics?.[metric] !== 0) throw new Error(`Frontend experience quality gate ${metric} must be zero`);
  }
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
  for (const capability of ["html", "css", "selector", "sass", "less"]) {
    const parser = object(parsers[capability], `Frontend version manifest requires parsers.${capability}`);
    if (parser.status !== "approved") throw new Error(`Frontend parser ${capability} is not approved`);
    nonEmptyString(parser.package, `parsers.${capability}.package`, "versions");
    nonEmptyString(parser.version, `parsers.${capability}.version`, "versions");
  }
  const trialCapabilities = object(manifest.trialCapabilities, "Frontend version manifest requires trialCapabilities");
  for (const capability of FRONTEND_TRIAL_CAPABILITIES) {
    const status = object(trialCapabilities[capability], `Frontend version manifest requires trialCapabilities.${capability}`);
    if (status.status !== "implemented-gated" || status.target !== "V1 Trial") {
      throw new Error(`Frontend trial capability ${capability} must remain implemented-gated for V1 Trial`);
    }
  }
  const secondaryCapabilities = object(manifest.secondaryCapabilities, "Frontend version manifest requires secondaryCapabilities");
  for (const capability of FRONTEND_SECONDARY_CAPABILITIES) {
    const status = object(secondaryCapabilities[capability], `Frontend version manifest requires secondaryCapabilities.${capability}`);
    if (status.status !== "basic-recognition" || status.target !== "V1.1") {
      throw new Error(`Frontend secondary capability ${capability} must remain basic-recognition for V1.1`);
    }
  }
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
  for (const capability of ["html", "css", "selector", "sass", "less"]) {
    const parser = manifest.parsers[capability];
    const declared = packageData.dependencies?.[parser.package];
    const locked = lockedPackages[`node_modules/${parser.package}`]?.version;
    if (declared !== parser.version || locked !== parser.version) {
      throw new Error(`Frontend version manifest parsers.${capability} must match direct locked ${parser.package} version`);
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
  const trialCapabilities = FRONTEND_TRIAL_CAPABILITIES.map((capability) => {
    const scoped = cases.filter((item) => item.trialCapability === capability);
    return {
      capability,
      train: scoped.filter((item) => item.split === "train").length,
      heldOut: scoped.filter((item) => item.split === "held-out").length
    };
  });
  const missingTrialEvidence = trialCapabilities.filter((item) => item.train < 1 || item.heldOut < 1);
  if (missingTrialEvidence.length) {
    throw new Error(`Frontend trial capability coverage is insufficient: ${missingTrialEvidence.map((item) => item.capability).join(", ")}`);
  }
  const chinese = cases.filter((item) => item.locale === "zh-CN").length;
  const negative = cases.filter((item) => item.access !== "authorized-published").length;
  const chineseRate = chinese / cases.length;
  const negativeRate = negative / cases.length;
  if (chineseRate < 0.4) throw new Error(`Frontend evaluation Chinese coverage ${chineseRate.toFixed(4)} is below 0.40`);
  if (negativeRate < 0.15) throw new Error(`Frontend evaluation negative coverage ${negativeRate.toFixed(4)} is below 0.15`);
  for (const split of SPLITS) {
    const access = new Set(cases.filter((item) => item.split === split).map((item) => item.access));
    if (!access.has("unauthorized") || !access.has("unpublished")) {
      throw new Error(`Frontend evaluation ${split} must cover unauthorized and unpublished access`);
    }
  }
  return {
    total: cases.length,
    chineseRate,
    negativeRate,
    capabilities,
    trialCapabilities,
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
    && actual.startLine <= citation.endLine
    && actual.endLine >= citation.startLine);
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
  let authorizedEmptyCases = 0;
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
        leakage += 1;
      }
      continue;
    }
    if (!item.expected.searchEntityIds.length) {
      authorizedEmptyCases += 1;
      const returnedAnything = (observation.entityIds?.length ?? 0) > 0
        || (observation.factEdgeIds?.length ?? 0) > 0
        || (observation.impactEntityIds?.length ?? 0) > 0
        || results.length > 0;
      if (returnedAnything) {
        falsePositiveEmpty += 1;
        failures.push({ caseId: item.id, kind: "unexpected-search-result" });
      }
      continue;
    }
    searchCases += 1;
    const rank = results.findIndex((result) => item.expected.searchEntityIds.includes(result.entityId));
    if (rank >= 0 && rank < 5) recalled += 1;
    else failures.push({ caseId: item.id, kind: "expected-search-result-missing" });
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
    if (rank < 0) citationsSeen += Math.max(1, item.expected.citations.length);
    for (const result of rank >= 0 ? [results[rank]] : []) {
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
  const rawCounts = {
    entity,
    edge,
    impact,
    capabilityEntities: Object.fromEntries(capabilityEntities),
    search: { cases: searchCases, recalled, reciprocalRanks },
    citations: { checked: citationsSeen, valid: validCitations },
    empty: { cases: authorizedEmptyCases, falsePositive: falsePositiveEmpty },
    negative: { cases: negativeCases, leakageCases: leakage }
  };
  return {
    protocolVersion: 1,
    caseIds: cases.map((item) => item.id),
    denominators: {
      totalCases: cases.length,
      positiveCases: searchCases,
      authorizedEmptyCases,
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
      falsePositiveEmptyRate: authorizedEmptyCases ? falsePositiveEmpty / authorizedEmptyCases : 0,
      impactPrecision: precision(impact),
      impactRecall: recall(impact),
      unauthorizedOrUnpublishedLeakage: leakage
    },
    rawCounts,
    failures
  };
}

export function evaluateFrontendKnowledgeBySplit(cases, observations) {
  const evaluateSplit = (split) => {
    const splitCases = cases.filter((item) => item.split === split);
    const caseIds = new Set(splitCases.map((item) => item.id));
    return evaluateFrontendKnowledge(splitCases, observations.filter((item) => caseIds.has(item.caseId)));
  };
  return {
    train: evaluateSplit("train"),
    heldOut: evaluateSplit("held-out"),
    all: evaluateFrontendKnowledge(cases, observations)
  };
}

export function evaluateFrontendTrialCapabilities(cases, observations) {
  return Object.fromEntries(FRONTEND_TRIAL_CAPABILITIES.map((capability) => {
    const scopedCases = cases.filter((item) => item.trialCapability === capability);
    const caseIds = new Set(scopedCases.map((item) => item.id));
    const scopedObservations = observations.filter((item) => caseIds.has(item.caseId));
    return [capability, evaluateFrontendKnowledgeBySplit(scopedCases, scopedObservations)];
  }));
}

function close(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-12;
}

export function assertFrontendEvaluationReport(report, cases) {
  const positiveCases = cases.filter((item) => item.access === "authorized-published" && item.expected.searchEntityIds.length).length;
  const authorizedEmptyCases = cases.filter((item) => item.access === "authorized-published" && !item.expected.searchEntityIds.length).length;
  const expectedDenominators = {
    totalCases: cases.length,
    positiveCases,
    authorizedEmptyCases,
    negativeCases: cases.length - positiveCases - authorizedEmptyCases,
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
    || report.denominators.authorizedEmptyCases !== raw.empty.cases
    || report.denominators.negativeCases !== raw.negative.cases
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
    falsePositiveEmptyRate: raw.empty.cases ? raw.empty.falsePositive / raw.empty.cases : 0,
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

export function assertFrontendQualityGate(report) {
  if (!report?.denominators?.totalCases) throw new Error("Frontend quality gate did not execute any held-out cases");
  const minimums = {
    entityMicroF1: 0.95,
    entityMacroF1: 0.95,
    factEdgePrecision: 1,
    factEdgeRecall: 0.75,
    recallAt5: 0.95,
    mrr: 0.9,
    citationValidity: 1,
    impactPrecision: 0.95,
    impactRecall: 0.95
  };
  for (const [metric, minimum] of Object.entries(minimums)) {
    if (!Number.isFinite(report.metrics?.[metric]) || report.metrics[metric] < minimum) {
      throw new Error(`Frontend quality gate ${metric} ${report.metrics?.[metric] ?? "missing"} is below ${minimum}`);
    }
  }
  if (report.metrics.falsePositiveEmptyRate > 0 || report.metrics.unauthorizedOrUnpublishedLeakage > 0) {
    throw new Error("Frontend quality gate found unauthorized, unpublished, or empty-query leakage");
  }
}

export function collectFrontendQualityGateFailures(reports, trialCapabilityReports = null) {
  const failures = [];
  for (const [name, report] of Object.entries(reports)) {
    try {
      assertFrontendQualityGate(report);
    } catch (error) {
      failures.push(new Error(`Frontend evaluation ${name} quality gate failed: ${error.message}`, { cause: error }));
    }
  }
  if (trialCapabilityReports) {
    for (const capability of FRONTEND_TRIAL_CAPABILITIES) {
      const scoped = trialCapabilityReports[capability] ?? {};
      for (const split of ["train", "heldOut", "all"]) {
        try {
          assertFrontendQualityGate(scoped[split]);
        } catch (error) {
          failures.push(new Error(
            `Frontend evaluation trialCapability.${capability}.${split} quality gate failed: ${error.message}`,
            { cause: error }
          ));
        }
      }
    }
  }
  return failures;
}

export function observeFrontendEvaluationCase(item, graph, documents, deriveImpact) {
  const buildId = `evaluation:${item.fixture}`;
  const results = searchFrontendKnowledge({
    query: item.query,
    documents,
    graph,
    access: {
      canReadProject: item.access !== "unauthorized",
      visibility: "published",
      viewerRole: "member",
      buildId,
      currentReleaseBuildId: item.access === "authorized-published" ? buildId : null
    },
    limit: 5
  });
  const target = results[0] ? graph.nodes.find((entity) => entity.id === results[0].entityId) : null;
  const changedPaths = target ? [...new Set(target.sourceRefs.map((reference) => reference.path))] : [];
  const impact = target ? deriveImpact({ changedPaths, graph: {
    schemaVersion: 2, snapshotId: graph.snapshotId, analyzerManifestDigest: graph.analyzerManifestDigest,
    analyzerManifest: [], entities: graph.nodes, edges: graph.edges
  } }) : null;
  const impacted = Boolean(target && impact?.affectedEntityIds.includes(target.id));
  return {
    caseId: item.id,
    entityIds: results[0] ? [results[0].entityKey] : [],
    factEdgeIds: results[0]?.factKeys ?? [],
    searchResults: results.map((result) => ({
      entityId: result.entityKey,
      citations: result.citations.map(({ path: citationPath, startLine, endLine }) => ({ path: citationPath, startLine, endLine }))
    })),
    impactEntityIds: impacted && results[0] ? [results[0].entityKey] : []
  };
}

async function fixtureFiles(root) {
  const walk = async (directory, prefix = "") => (await readdir(directory)).flatMap((name) => [{ name, prefix }]);
  const pending = await walk(root);
  const files = [];
  while (pending.length) {
    const current = pending.shift();
    const relative = current.prefix ? `${current.prefix}/${current.name}` : current.name;
    const absolute = path.join(root, relative);
    if ((await stat(absolute)).isDirectory()) {
      pending.push(...await walk(absolute, relative));
    } else files.push(relative);
  }
  return files.sort();
}

async function loadDataset(root, filename, split) {
  return { name: filename, split, content: await readFile(path.join(root, filename), "utf8") };
}

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = await Promise.all([
    loadDataset(root, "evaluation/frontend/train/react-core.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/train/react-trial.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/train/security-negative.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/train/no-result.jsonl", "train"),
    loadDataset(root, "evaluation/frontend/held-out/react-core.jsonl", "held-out"),
    loadDataset(root, "evaluation/frontend/held-out/react-trial.jsonl", "held-out"),
    loadDataset(root, "evaluation/frontend/held-out/security-negative.jsonl", "held-out"),
    loadDataset(root, "evaluation/frontend/held-out/no-result.jsonl", "held-out")
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
  const [{ analyzeWorkerRequest }, { buildFrontendGraph }, { deriveFrontendChangeImpact }] = await Promise.all([
    import("../src/server/knowledge/frontend/runtime/analyzer-worker.ts"),
    import("../src/server/knowledge/frontend/graph-builder.ts"),
    import("../src/server/knowledge/frontend/change-impact.ts")
  ]);
  const fixtureKnowledge = new Map();
  for (const fixture of new Set(cases.map((item) => item.fixture))) {
    const fixtureRoot = path.join(root, "fixtures/frontend", fixture);
    const sources = await Promise.all((await fixtureFiles(fixtureRoot)).map(async (sourcePath) => {
      const bytes = await readFile(path.join(fixtureRoot, sourcePath));
      return { path: sourcePath, contentBase64: bytes.toString("base64"), blobHash: createHash("sha256").update(bytes).digest("hex") };
    }));
    const result = analyzeWorkerRequest({
      type: "analyze", requestId: createHash("sha256").update(fixture).digest("hex").slice(0, 8) + "-0000-4000-8000-000000000000",
      snapshotId: fixture,
      analyzerIds: ["frontend-project", "frontend-project-core", "typescript-core", "html-core", "style-core", "react-core", "react-ecosystem-core", "react-router-core", "state-data-core", "visualization-core", "tooling-test-core"],
      cachedAnalyses: [], sources
    });
    const graph = buildFrontendGraph(result.outputs[0].frontendIr);
    const pages = generateFrontendKnowledge({
      schemaVersion: 2,
      snapshotId: graph.snapshotId,
      analyzerManifestDigest: graph.analyzerManifestDigest,
      analyzerManifest: [],
      entities: graph.nodes,
      edges: graph.edges
    }).pages;
    fixtureKnowledge.set(fixture, { graph, documents: buildFrontendSearchDocuments(pages) });
  }
  const observations = cases.map((item) => {
    const knowledge = fixtureKnowledge.get(item.fixture);
    return observeFrontendEvaluationCase(item, knowledge.graph, knowledge.documents, deriveFrontendChangeImpact);
  });
  const splitReports = evaluateFrontendKnowledgeBySplit(cases, observations);
  for (const [split, report] of Object.entries(splitReports)) {
    const scopedCases = split === "all" ? cases : cases.filter((item) => item.split === (split === "heldOut" ? "held-out" : split));
    try {
      assertFrontendEvaluationReport(report, scopedCases);
    } catch (error) {
      throw new Error(`Frontend evaluation ${split} report is invalid: ${error.message}`, { cause: error });
    }
  }
  const trialCapabilityReports = evaluateFrontendTrialCapabilities(cases, observations);
  for (const [capability, reports] of Object.entries(trialCapabilityReports)) {
    for (const [split, report] of Object.entries(reports)) {
      const scopedCases = cases.filter((item) => item.trialCapability === capability
        && (split === "all" || item.split === (split === "heldOut" ? "held-out" : split)));
      try {
        assertFrontendEvaluationReport(report, scopedCases);
      } catch (error) {
        throw new Error(`Frontend evaluation trialCapability.${capability}.${split} report is invalid: ${error.message}`, { cause: error });
      }
    }
  }
  const [qualityGateError = null] = collectFrontendQualityGateFailures(splitReports, trialCapabilityReports);
  const output = {
    dataset: "frontend-v1-core",
    datasetDigest,
    status: qualityGateError ? "quality-gate-failed" : "quality-gate-passed",
    qualityGateEnforced: true,
    qualityGateReports: ["train", "heldOut", "all"],
    generatedFromCommittedFixtures: true,
    suite,
    observations,
    splitReports,
    trialCapabilityReports,
    report: splitReports.all
  };
  const outputPath = path.join(root, "artifacts/frontend-knowledge-evaluation.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  if (qualityGateError) throw qualityGateError;
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

export async function mainFrontendExperience() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = await Promise.all(FRONTEND_EXPERIENCE_CAPABILITIES.flatMap((capability) => [
    loadDataset(root, `evaluation/frontend/train/experience-${capability}.jsonl`, "train"),
    loadDataset(root, `evaluation/frontend/held-out/experience-${capability}.jsonl`, "held-out")
  ]));
  const cases = parseFrontendExperienceEvaluationDatasets(inputs);
  const datasetDigest = digestFrontendEvaluationDatasets(inputs);
  const suite = validateFrontendExperienceEvaluationSuite(cases);
  const splitReports = evaluateFrontendExperienceBySplit(cases);
  for (const [split, report] of Object.entries(splitReports)) {
    try {
      assertFrontendExperienceQualityGate(report);
    } catch (error) {
      throw new Error(`Frontend experience ${split} quality gate failed: ${error.message}`, { cause: error });
    }
  }
  const output = {
    dataset: "frontend-experience-v1",
    datasetDigest,
    status: "quality-gate-passed",
    qualityGateEnforced: true,
    qualityGateReports: ["train", "heldOut", "all"],
    suite,
    splitReports,
    report: splitReports.all
  };
  const outputPath = path.join(root, "artifacts/frontend-experience-evaluation.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    dataset: output.dataset,
    datasetDigest,
    status: output.status,
    totalCases: suite.total,
    chineseRate: suite.chineseRate,
    negativeRate: suite.negativeRate,
    metrics: output.report.metrics,
    report: path.relative(root, outputPath)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selectedMain = process.argv.includes("--experience") ? mainFrontendExperience : main;
  selectedMain().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
