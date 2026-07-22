import type {
  DeclaredDecisionEvidence,
  ExperienceSourceEligibility,
  ExperienceState
} from "../../../shared/frontend-experience.js";

export interface ExperienceLifecycleContext {
  state: ExperienceState;
  evidence: Array<{
    id: string;
    sourceEligibility: ExperienceSourceEligibility;
    revokedAt: Date | null;
  }>;
  decisions: Array<Pick<DeclaredDecisionEvidence, "id" | "decision" | "basisEvidenceIds">>;
}

export interface ExperienceLifecycleTransition {
  to: ExperienceState;
  actorId: string;
  reason: string;
  basisEvidenceIds: string[];
  decisionId: string | null;
}

const allowed: Record<ExperienceState, readonly ExperienceState[]> = {
  candidate: ["verified", "rejected"],
  verified: ["recommended", "deprecated", "rejected"],
  recommended: ["standard", "deprecated"],
  standard: ["deprecated"],
  rejected: [],
  deprecated: []
};

export function transitionExperience(
  current: ExperienceLifecycleContext,
  transition: ExperienceLifecycleTransition
): void {
  if (!allowed[current.state].includes(transition.to)) {
    throw new Error(`Invalid experience transition: ${current.state} -> ${transition.to}`);
  }
  const evidence = current.evidence.filter((item) =>
    transition.basisEvidenceIds.includes(item.id) && item.revokedAt === null
  );
  if (transition.basisEvidenceIds.length !== evidence.length) {
    throw new Error("Experience transition basis is missing or revoked");
  }
  if (transition.to === "verified" && evidence.length === 0) {
    throw new Error("Verified experience requires evidence");
  }
  if (transition.to === "recommended") {
    const approved = current.decisions.find((decision) =>
      decision.id === transition.decisionId
      && decision.decision === "approve"
      && transition.basisEvidenceIds.every((id) => decision.basisEvidenceIds.includes(id))
    );
    const eligible = evidence.some((item) =>
      item.sourceEligibility === "git" || item.sourceEligibility === "git_linked"
    );
    if (!approved || !eligible) {
      throw new Error("Recommended experience requires visible eligible evidence and an approved decision");
    }
  }
  if (transition.to === "standard" && !current.decisions.some((decision) =>
    decision.id === transition.decisionId && decision.decision === "standardize"
  )) {
    throw new Error("Standard experience requires an explicit standardization decision");
  }
}
