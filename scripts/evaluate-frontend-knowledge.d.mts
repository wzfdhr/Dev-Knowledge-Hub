export interface FrontendEvaluationInput {
  name: string;
  split: "train" | "held-out";
  content: string;
}

export const FRONTEND_TRIAL_CAPABILITIES: readonly string[];
export const FRONTEND_EXPERIENCE_CAPABILITIES: readonly string[];

export interface FrontendExperienceEvaluationCase {
  id: string;
  split: "train" | "held-out";
  capability: string;
  locale: "en" | "zh-CN";
  query: string;
  currentProjectId: string;
  currentProjectProfile: Record<string, string>;
  visibleReleaseIds: string[];
  visibleEvidenceIds: string[];
  invisibleEvidenceIds: string[];
  candidates: Array<{
    id: string;
    sourceProjectId: string;
    releaseId: string;
    evidenceId: string;
    sourceEligibility: "git" | "git_linked" | "admin_attested" | "unverified_upload";
    lifecycle: "verified" | "recommended" | "standard" | "deprecated";
    evidenceState: "active" | "revoked";
    required: Array<{ key: string; value: string }>;
    forbidden: Array<{ key: string; value: string }>;
  }>;
  expectedDecision: "recommend" | "reject" | "abstain" | "no_result";
  expectedRecommendationIds: string[];
  expectedRejectionReasons: string[];
  expectedUnknownKeys: string[];
  abstentionRequired: boolean;
}

export interface FrontendExperienceEvaluationReport {
  protocolVersion: number;
  caseIds: string[];
  observations: Array<{
    caseId: string;
    decision: string;
    recommendationIds: string[];
    rejected: Array<{ candidateId: string; reason: string; unknownKey?: string }>;
    unknownKeys: string[];
  }>;
  denominators: Record<string, number>;
  metrics: Record<string, number>;
  failures: Array<{ caseId: string; expectedDecision: string; observation: unknown }>;
}

export interface FrontendCitation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface FrontendExpectedCitation extends FrontendCitation {
  entityId: string;
}

export interface FrontendEvaluationCase {
  id: string;
  scenarioKey: string;
  split: "train" | "held-out";
  capability: string;
  trialCapability?: string;
  locale: "en" | "zh-CN";
  access: "authorized-published" | "unauthorized" | "unpublished";
  expected: {
    entityIds: string[];
    factEdgeIds: string[];
    searchEntityIds: string[];
    impactEntityIds: string[];
    citations: FrontendExpectedCitation[];
  };
  forbiddenEntityIds: string[];
  forbiddenFactEdgeIds: string[];
  forbiddenCitations: FrontendExpectedCitation[];
}

export interface FrontendEvaluationObservation {
  caseId: string;
  entityIds: string[];
  factEdgeIds: string[];
  searchResults: Array<{ entityId: string; citations: FrontendCitation[] }>;
  impactEntityIds: string[];
}

export interface FrontendEvaluationReport {
  protocolVersion: number;
  caseIds: string[];
  denominators: Record<string, number>;
  metrics: Record<string, number>;
  rawCounts: Record<string, unknown>;
  failures: Array<{ caseId: string; kind: string }>;
}

export interface FrontendVersionManifest {
  currentRepository: {
    react: string;
    reactDom: string;
    vite: string;
    typescript: string;
  };
  compatibilityFixtures: Array<{ fixture: string; react: string; [key: string]: unknown }>;
  parsers: { typescript: string; [key: string]: unknown };
  [key: string]: unknown;
}

export function digestFrontendEvaluationDatasets(inputs: FrontendEvaluationInput[]): string;
export function parseFrontendEvaluationDatasets(inputs: FrontendEvaluationInput[]): FrontendEvaluationCase[];
export function parseFrontendExperienceEvaluationDatasets(
  inputs: FrontendEvaluationInput[]
): FrontendExperienceEvaluationCase[];
export function validateFrontendExperienceEvaluationSuite(cases: FrontendExperienceEvaluationCase[]): {
  total: number;
  chineseRate: number;
  negativeRate: number;
  capabilities: Array<{ capability: string; train: number; heldOut: number }>;
  negativeKinds: string[];
};
export function evaluateFrontendExperience(cases: FrontendExperienceEvaluationCase[]): FrontendExperienceEvaluationReport;
export function evaluateFrontendExperienceBySplit(cases: FrontendExperienceEvaluationCase[]): {
  train: FrontendExperienceEvaluationReport;
  heldOut: FrontendExperienceEvaluationReport;
  all: FrontendExperienceEvaluationReport;
};
export function assertFrontendExperienceQualityGate(report: Pick<
  FrontendExperienceEvaluationReport,
  "denominators" | "metrics"
>): void;
export function validateFrontendFixtureReferences(cases: FrontendEvaluationCase[], fixturesRoot: string): Promise<void>;
export function validateFrontendEvaluationSuite(cases: FrontendEvaluationCase[], versionManifest: unknown): {
  total: number;
  chineseRate: number;
  negativeRate: number;
  capabilities: Array<{ capability: string; train: number; heldOut: number }>;
  trialCapabilities: Array<{ capability: string; train: number; heldOut: number }>;
  versionManifest: FrontendVersionManifest;
};
export function validateFrontendVersionManifestAgainstPackage(
  versionManifest: unknown,
  packageJson: unknown,
  packageLock: unknown
): void;
export function validateFrontendCompatibilityFixtures(versionManifest: unknown, fixturesRoot: string): Promise<void>;
export function validateFrontendPerformanceBaseline(versionManifest: unknown, datasetDigest: string): void;
export function evaluateFrontendKnowledge(
  cases: FrontendEvaluationCase[],
  observations: FrontendEvaluationObservation[]
): FrontendEvaluationReport;
export function evaluateFrontendKnowledgeBySplit(
  cases: FrontendEvaluationCase[],
  observations: FrontendEvaluationObservation[]
): { train: FrontendEvaluationReport; heldOut: FrontendEvaluationReport; all: FrontendEvaluationReport };
export function evaluateFrontendTrialCapabilities(
  cases: FrontendEvaluationCase[],
  observations: FrontendEvaluationObservation[]
): Record<string, { train: FrontendEvaluationReport; heldOut: FrontendEvaluationReport; all: FrontendEvaluationReport }>;
export function assertFrontendEvaluationReport(report: FrontendEvaluationReport, cases: FrontendEvaluationCase[]): void;
export function assertFrontendQualityGate(report: Pick<FrontendEvaluationReport, "denominators" | "metrics">): void;
export function collectFrontendQualityGateFailures(
  reports: Record<string, Pick<FrontendEvaluationReport, "denominators" | "metrics">>,
  trialCapabilityReports?: Record<string, Record<string, Pick<FrontendEvaluationReport, "denominators" | "metrics">>>
): Error[];
export function observeFrontendEvaluationCase(
  item: FrontendEvaluationCase,
  graph: unknown,
  documents: unknown[],
  deriveImpact: (input: unknown) => { affectedEntityIds: string[] }
): FrontendEvaluationObservation;
