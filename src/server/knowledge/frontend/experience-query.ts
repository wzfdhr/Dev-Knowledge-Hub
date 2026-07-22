import type { SourceRef } from "../../../shared/api-contracts.js";
import type {
  ExperienceSourceEligibility,
  ExperienceState,
  ProjectPredicate,
  ProjectPredicateKey
} from "../../../shared/frontend-experience.js";
import type { FrontendProjectProfile } from "../../../shared/frontend-project-profile.js";
import { classifyFrontendExperienceIntent } from "./search-intent.js";
import { appliesOutcomeToRecommendation } from "./outcome-verifier.js";

export const APPLICABILITY_REJECTION_REASONS = [
  "SOURCE_INELIGIBLE", "LIFECYCLE_INELIGIBLE", "EVIDENCE_STALE", "EVIDENCE_PAUSED",
  "FRAMEWORK_MISMATCH", "FRAMEWORK_VERSION_MISMATCH", "REQUIRED_CONDITION_MISMATCH",
  "FORBIDDEN_CONDITION_MATCH", "REQUIRED_ATTRIBUTE_UNKNOWN"
] as const;
export type ApplicabilityRejectionReason = (typeof APPLICABILITY_REJECTION_REASONS)[number];

export interface VisibleExperienceEvidence {
  id: string;
  projectId: string;
  releaseId: string;
  sourceEligibility: ExperienceSourceEligibility;
  title: string;
  observedFact: string;
  contentVersion: string;
  citations: SourceRef[];
  releasePublishedAt: Date;
  fresh: boolean;
}

export interface VisibleExperienceCandidate {
  experienceId: string;
  capability: string;
  state: ExperienceState;
  supersededById: string | null;
  evidence: VisibleExperienceEvidence[];
  decisions: Array<{
    id: string;
    decision: "approve" | "reject" | "deprecate" | "standardize";
    basisEvidenceIds: string[];
    applicability: {
      required: ProjectPredicate[];
      forbidden: ProjectPredicate[];
      preferred: ProjectPredicate[];
      unsupportedWhenUnknown: ProjectPredicateKey[];
    };
    createdAt: Date;
  }>;
  outcomes: Array<{
    authority: "signed_ci" | "admin_confirmed" | "user_reported";
    outcome: "passed" | "failed" | "rolled_back" | "partial";
    evidenceId: string | null;
    sourceVersion: string;
  }>;
  standards: Array<{ id: string; title: string; body: string; createdAt: Date }>;
  reviews?: Array<{
    id: string;
    fromState: ExperienceState;
    toState: ExperienceState;
    basisEvidenceIds: string[];
    decisionId: string | null;
    createdAt: Date;
  }>;
}

export interface ExperienceQueryStore {
  listVisibleExperienceCandidates(input: {
    workspaceId: string;
    userId: string;
    currentProjectId: string;
  }): Promise<VisibleExperienceCandidate[]>;
}

export interface ExperienceQueryInput {
  store: ExperienceQueryStore;
  workspaceId: string;
  userId: string;
  currentProjectId: string;
  currentProfile: FrontendProjectProfile;
  query: string;
}

export interface ApplicableExperienceProjection {
  id: string;
  capability: string;
  state: "recommended" | "standard";
  title: string;
  observedFacts: string[];
  evidenceCount: number;
  citations: SourceRef[];
  trustScore: number;
  rankScore: number;
}

export interface ExperienceQueryResult {
  schemaVersion: 1;
  rankingVersion: 1;
  applicableExperiences: ApplicableExperienceProjection[];
  rejectedExperiences: Array<{
    experienceId: string;
    reasons: ApplicabilityRejectionReason[];
  }>;
  visibleReleaseIds: string[];
}

const lifecycleOrder: Record<ExperienceState, number> = {
  candidate: 0, verified: 1, recommended: 2, standard: 3,
  rejected: 3, deprecated: 4
};

type ProfileValue =
  | { state: "known"; value: unknown }
  | { state: "unknown" | "unsupported"; reason: string; value?: unknown };

function profileValue(profile: FrontendProjectProfile, key: ProjectPredicateKey): ProfileValue {
  const [section, property] = key.split(".") as [keyof FrontendProjectProfile, string];
  const entry = profile[section] as ProfileValue | undefined;
  if (!entry || entry.state !== "known") return entry ?? { state: "unknown", reason: "unresolved" };
  if (!property) return entry;
  const value = entry.value && typeof entry.value === "object"
    ? (entry.value as Record<string, unknown>)[property]
    : undefined;
  return value === undefined ? { state: "unknown", reason: "unresolved" } : { state: "known", value };
}

function numericVersion(value: string): number[] | null {
  const match = value.trim().replace(/^v/u, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionSatisfies(value: string, range: string): boolean {
  const version = numericVersion(value);
  if (!version) return false;
  return range.trim().split(/\s+/u).every((part) => {
    const operator = part.match(/^(\^|~|>=|<=|>|<|=)?(.*)$/u);
    const expected = numericVersion(operator?.[2] ?? "");
    if (!operator || !expected) return false;
    const comparison = compareVersion(version, expected);
    switch (operator[1] ?? "=") {
      case "^": return comparison >= 0 && version[0] === expected[0];
      case "~": return comparison >= 0 && version[0] === expected[0] && version[1] === expected[1];
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
}

function predicateMatches(profile: FrontendProjectProfile, predicate: ProjectPredicate): boolean | null {
  const current = profileValue(profile, predicate.key);
  if (current.state !== "known") return null;
  const values = Array.isArray(current.value) ? current.value : [current.value];
  const normalized = values.map((value) => String(value).toLocaleLowerCase());
  const expected = predicate.value.toLocaleLowerCase();
  switch (predicate.operator) {
    case "equals": return normalized.length === 1 && normalized[0] === expected;
    case "not_equals": return !normalized.includes(expected);
    case "includes": return normalized.includes(expected);
    case "semver_satisfies": return typeof current.value === "string"
      && versionSatisfies(current.value, predicate.value);
  }
}

function requiredMismatchReason(predicate: ProjectPredicate): ApplicabilityRejectionReason {
  if (predicate.key === "framework.name") return "FRAMEWORK_MISMATCH";
  if (predicate.key === "framework.version") return "FRAMEWORK_VERSION_MISMATCH";
  return "REQUIRED_CONDITION_MISMATCH";
}

function uniqueCitations(evidence: VisibleExperienceEvidence[]): SourceRef[] {
  const values = new Map<string, SourceRef>();
  for (const item of evidence) for (const citation of item.citations) {
    values.set(`${citation.snapshotId}:${citation.path}:${citation.startLine}:${citation.endLine}`, citation);
  }
  return [...values.values()].sort((left, right) => left.path.localeCompare(right.path)
    || left.startLine - right.startLine || left.endLine - right.endLine);
}

export async function queryExperienceProjection(input: ExperienceQueryInput): Promise<ExperienceQueryResult> {
  const candidates = await input.store.listVisibleExperienceCandidates({
    workspaceId: input.workspaceId, userId: input.userId, currentProjectId: input.currentProjectId
  });
  const intents = classifyFrontendExperienceIntent(input.query);
  const rejectedExperiences: ExperienceQueryResult["rejectedExperiences"] = [];
  const applicable: ApplicableExperienceProjection[] = [];
  const visibleReleaseIds = [...new Set(candidates.flatMap((candidate) =>
    candidate.evidence.map((evidence) => evidence.releaseId)
  ))].sort();

  for (const candidate of candidates) {
    const reasons: ApplicabilityRejectionReason[] = [];
    const visibleEvidenceIds = new Set(candidate.evidence.map((item) => item.id));
    const decisions = candidate.decisions.filter((decision) =>
      decision.basisEvidenceIds.every((id) => visibleEvidenceIds.has(id))
    ).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id));
    const visibleDecisionIds = new Set(decisions.map((item) => item.id));
    const visibleReviews = (candidate.reviews ?? []).filter((review) =>
      review.basisEvidenceIds.every((id) => visibleEvidenceIds.has(id))
      && (review.decisionId === null || visibleDecisionIds.has(review.decisionId))
    ).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
      || lifecycleOrder[left.fromState] - lifecycleOrder[right.fromState]
      || left.id.localeCompare(right.id));
    const effectiveState = visibleReviews.length > 0
      ? visibleReviews.reduce<ExperienceState>((state, review) =>
        review.fromState === state ? review.toState : state, "candidate")
      : candidate.state;
    const requiredDecision = effectiveState === "standard" ? "standardize" : "approve";
    const decision = decisions.find((item) => item.decision === requiredDecision);
    let evidence = candidate.evidence.filter((item) =>
      item.sourceEligibility === "git" || item.sourceEligibility === "git_linked"
    );
    if (evidence.length === 0) reasons.push("SOURCE_INELIGIBLE");
    if (!["recommended", "standard"].includes(effectiveState) || !decision) {
      reasons.push("LIFECYCLE_INELIGIBLE");
    }
    const fresh = evidence.filter((item) => item.fresh);
    if (evidence.length > 0 && fresh.length === 0) reasons.push("EVIDENCE_STALE");
    evidence = fresh;
    const unpaused = evidence.filter((item) => !candidate.outcomes.some((outcome) =>
      outcome.evidenceId === item.id && outcome.sourceVersion === item.contentVersion
      && appliesOutcomeToRecommendation(outcome)
    ));
    if (evidence.length > 0 && unpaused.length === 0) reasons.push("EVIDENCE_PAUSED");
    evidence = unpaused;

    if (decision) {
      for (const predicate of decision.applicability.required) {
        const matches = predicateMatches(input.currentProfile, predicate);
        if (matches === null) reasons.push("REQUIRED_ATTRIBUTE_UNKNOWN");
        else if (!matches) reasons.push(requiredMismatchReason(predicate));
      }
      for (const predicate of decision.applicability.forbidden) {
        if (predicateMatches(input.currentProfile, predicate) === true) {
          reasons.push("FORBIDDEN_CONDITION_MATCH");
        }
      }
      if (decision.applicability.unsupportedWhenUnknown.some((key) =>
        profileValue(input.currentProfile, key).state !== "known"
      )) reasons.push("REQUIRED_ATTRIBUTE_UNKNOWN");
    }

    const uniqueReasons = [...new Set(reasons)];
    if (uniqueReasons.length > 0) {
      rejectedExperiences.push({ experienceId: candidate.experienceId, reasons: uniqueReasons });
      continue;
    }
    const preferredMatches = decision!.applicability.preferred.filter((predicate) =>
      predicateMatches(input.currentProfile, predicate) === true
    ).length;
    const passedOutcomes = candidate.outcomes.filter((outcome) => outcome.outcome === "passed"
      && outcome.evidenceId !== null && evidence.some((item) =>
        item.id === outcome.evidenceId && item.contentVersion === outcome.sourceVersion
      ));
    const intentScore = intents.includes(candidate.capability as never) ? 40 : 0;
    const trustScore = Math.min(1, 0.45 + evidence.length * 0.15
      + (passedOutcomes.some((item) => item.authority === "signed_ci") ? 0.2 : 0)
      + (effectiveState === "standard" ? 0.1 : 0));
    const title = effectiveState === "standard" && candidate.standards[0]
      ? candidate.standards[0].title
      : evidence[0]!.title;
    applicable.push({
      id: candidate.experienceId, capability: candidate.capability,
      state: effectiveState as "recommended" | "standard", title,
      observedFacts: evidence.map((item) => item.observedFact), evidenceCount: evidence.length,
      citations: uniqueCitations(evidence), trustScore,
      rankScore: intentScore + evidence.length * 10 + preferredMatches * 5
        + passedOutcomes.filter((item) => item.authority === "signed_ci").length * 8
    });
  }

  applicable.sort((left, right) => right.rankScore - left.rankScore
    || right.trustScore - left.trustScore || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id));
  rejectedExperiences.sort((left, right) => left.experienceId.localeCompare(right.experienceId));
  return {
    schemaVersion: 1, rankingVersion: 1, applicableExperiences: applicable,
    rejectedExperiences, visibleReleaseIds
  };
}
