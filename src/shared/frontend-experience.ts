import { z } from "zod";

import { sourceRefSchema } from "./api-contracts.js";

export const EXPERIENCE_STATES = [
  "candidate", "verified", "recommended", "standard", "rejected", "deprecated"
] as const;
export const EXPERIENCE_SOURCE_ELIGIBILITY = [
  "git", "git_linked", "admin_attested", "unverified_upload"
] as const;
export const EXPERIENCE_FEEDBACK_EVENTS = [
  "considered", "adopted", "partially_adopted", "rejected", "failed", "rolled_back"
] as const;

export const experienceStateSchema = z.enum(EXPERIENCE_STATES);
export const experienceSourceEligibilitySchema = z.enum(EXPERIENCE_SOURCE_ELIGIBILITY);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const projectPredicateKeySchema = z.enum([
  "framework.name", "framework.version", "rendering.modes", "router.libraries",
  "state.libraries", "data.libraries", "formLibrary.libraries", "tooling.buildTools",
  "styles.systems", "styles.componentLibraries", "visualizations.libraries", "tests.tools",
  "workspace.kind", "workspace.packageManager"
]);
export const projectPredicateSchema = z.object({
  key: projectPredicateKeySchema,
  operator: z.enum(["equals", "not_equals", "includes", "semver_satisfies"]),
  value: z.string().trim().min(1).max(240)
}).strict();

export const observedPatternEvidenceInputSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  projectId: z.string().min(1),
  releaseId: z.string().min(1),
  snapshotId: z.string().min(1),
  capability: z.string().min(1),
  sourceEligibility: experienceSourceEligibilitySchema,
  title: z.string().min(1).max(240),
  observedFact: z.string().min(1).max(4_000),
  profileDigest: digestSchema,
  contentVersion: z.string().min(1),
  citations: z.array(sourceRefSchema).min(1)
}).strict().superRefine((value, context) => {
  if (value.citations.some((citation) => citation.snapshotId !== value.snapshotId)) {
    context.addIssue({ code: "custom", message: "Observed evidence citations cross snapshots" });
  }
});

export const observedPatternEvidenceSchema = observedPatternEvidenceInputSchema.extend({
  revokedAt: z.date().nullable(),
  createdAt: z.date()
}).strict();

export const declaredDecisionInputSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  actorId: z.string().min(1),
  decision: z.enum(["approve", "reject", "deprecate", "standardize"]),
  reason: z.string().min(1).max(2_000),
  basisEvidenceIds: z.array(z.string().min(1)).min(1),
  applicability: z.object({
    required: z.array(projectPredicateSchema),
    forbidden: z.array(projectPredicateSchema),
    preferred: z.array(projectPredicateSchema),
    unsupportedWhenUnknown: z.array(projectPredicateKeySchema)
  }).strict()
}).strict();

export const declaredDecisionSchema = declaredDecisionInputSchema.extend({
  createdAt: z.date()
}).strict();

export const verifiedOutcomeInputSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  evidenceId: z.string().min(1).nullable(),
  authority: z.enum(["signed_ci", "admin_confirmed", "user_reported"]),
  outcome: z.enum(["passed", "failed", "rolled_back", "partial"]),
  sourceVersion: z.string().min(1),
  checks: z.array(z.object({
    name: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"])
  }).strict()),
  reportDigest: digestSchema.nullable(),
  recordedBy: z.string().min(1)
}).strict();

export const verifiedOutcomeSchema = verifiedOutcomeInputSchema.extend({ createdAt: z.date() }).strict();

export const experienceFeedbackEventSchema = z.enum(EXPERIENCE_FEEDBACK_EVENTS);

export const experienceReviewItemInputSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  evidenceId: z.string().min(1).nullable(),
  outcomeId: z.string().min(1).nullable(),
  reportedBy: z.string().min(1),
  kind: z.enum(["trusted_negative_outcome", "user_feedback", "knowledge_lint"]),
  priority: z.enum(["high", "normal"]),
  feedbackEvent: experienceFeedbackEventSchema.nullable(),
  currentProjectId: z.string().min(1).nullable(),
  sourceVersion: z.string().min(1),
  taskSummary: z.string().trim().min(1).max(2_000)
}).strict().superRefine((value, context) => {
  if (value.kind === "trusted_negative_outcome"
    && (value.outcomeId === null || value.feedbackEvent !== null || value.priority !== "high")) {
    context.addIssue({ code: "custom", message: "Trusted negative outcome review item is invalid" });
  }
  if (value.kind === "user_feedback"
    && (value.outcomeId !== null || value.feedbackEvent === null || value.currentProjectId === null
      || value.priority !== "normal")) {
    context.addIssue({ code: "custom", message: "User feedback review item is invalid" });
  }
  if (value.kind === "knowledge_lint"
    && (value.outcomeId !== null || value.feedbackEvent !== null || value.currentProjectId !== null
      || value.priority !== "high")) {
    context.addIssue({ code: "custom", message: "Knowledge Lint review item is invalid" });
  }
});

export const experienceReviewItemSchema = experienceReviewItemInputSchema.extend({
  createdAt: z.date()
}).strict();

export const experienceReviewEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  actorId: z.string().min(1),
  fromState: experienceStateSchema,
  toState: experienceStateSchema,
  reason: z.string().min(1),
  basisEvidenceIds: z.array(z.string().min(1)),
  decisionId: z.string().min(1).nullable(),
  createdAt: z.date()
}).strict().refine((value) => value.basisEvidenceIds.length > 0 || value.decisionId !== null, {
  message: "Experience review requires a non-empty basis"
});

export const workspaceStandardInputSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  title: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  authoredBy: z.string().min(1),
  supersededById: z.string().min(1).nullable().default(null)
}).strict().refine((value) => value.supersededById !== value.id, {
  message: "Workspace standard cannot supersede itself"
});

export const workspaceStandardSchema = workspaceStandardInputSchema.extend({
  createdAt: z.date()
}).strict().refine((value) => value.supersededById !== value.id, {
  message: "Workspace standard cannot supersede itself"
});

export type ExperienceState = z.infer<typeof experienceStateSchema>;
export type ExperienceSourceEligibility = z.infer<typeof experienceSourceEligibilitySchema>;
export type ProjectPredicateKey = z.infer<typeof projectPredicateKeySchema>;
export type ProjectPredicate = z.infer<typeof projectPredicateSchema>;
export type ObservedPatternEvidenceInput = z.input<typeof observedPatternEvidenceInputSchema>;
export type ObservedPatternEvidence = z.infer<typeof observedPatternEvidenceSchema>;
export type DeclaredDecisionInput = z.input<typeof declaredDecisionInputSchema>;
export type DeclaredDecisionEvidence = z.infer<typeof declaredDecisionSchema>;
export type VerifiedOutcomeInput = z.input<typeof verifiedOutcomeInputSchema>;
export type VerifiedOutcomeEvidence = z.infer<typeof verifiedOutcomeSchema>;
export type ExperienceFeedbackEvent = z.infer<typeof experienceFeedbackEventSchema>;
export type ExperienceReviewItemInput = z.input<typeof experienceReviewItemInputSchema>;
export type ExperienceReviewItem = z.infer<typeof experienceReviewItemSchema>;
export type ExperienceReviewEvent = z.infer<typeof experienceReviewEventSchema>;
export type WorkspaceStandardInput = z.input<typeof workspaceStandardInputSchema>;
export type WorkspaceStandard = z.infer<typeof workspaceStandardSchema>;

export interface ExperienceProjection {
  experienceId: string;
  capability: string;
  state: ExperienceState;
  title: string;
  observedFacts: string[];
  evidenceCount: number;
}

export interface ExperienceProjectionInput {
  workspaceId: string;
  userId: string;
  currentProjectId: string;
  query: string;
}

export interface ExperienceTransitionInput {
  workspaceId: string;
  patternGroupId: string;
  to: ExperienceState;
  actorId: string;
  reason: string;
  basisEvidenceIds: string[];
  decisionId: string | null;
  supersededById?: string | null;
}
