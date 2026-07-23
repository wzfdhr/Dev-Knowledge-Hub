import type { SourceRef } from "./api-contracts.js";
import type { ApplicabilityRejectionReason } from "../server/knowledge/frontend/experience-query.js";

export interface CitedProjectFact {
  key: string;
  label: string;
  value: string;
  citations: SourceRef[];
}

export interface CitedConstraint {
  key: string;
  statement: string;
  citations: SourceRef[];
}

export interface CitedExperienceProjection {
  id: string;
  title: string;
  capability: string;
  state: "recommended" | "standard";
  observedFacts: string[];
  evidenceCount: number;
  trustScore: number;
  citations: SourceRef[];
}

export interface FrontendSolutionContext {
  schemaVersion: 1;
  currentProject: {
    projectId: string;
    releaseId: string | null;
    sourceVersion: string | null;
    status: "ready" | "no_release" | "stale" | "unsupported";
  };
  currentProjectFacts: CitedProjectFact[];
  hardConstraints: CitedConstraint[];
  applicableExperiences: CitedExperienceProjection[];
  rejectedExperiences: Array<{
    experienceId: string;
    reasons: ApplicabilityRejectionReason[];
  }>;
  unknowns: Array<{ key: string; reason: string; requiredForRecommendation: boolean }>;
  changeImpact: Array<{ path: string; reason: string; citations: SourceRef[] }>;
  verificationPlan: Array<{ step: string; reason: string; citations: SourceRef[] }>;
}
