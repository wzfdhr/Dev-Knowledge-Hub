import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  declaredDecisionInputSchema,
  experienceFeedbackEventSchema,
  verifiedOutcomeInputSchema,
  workspaceStandardInputSchema,
  type DeclaredDecisionInput,
  type ExperienceReviewItem,
  type ExperienceReviewEvent,
  type VerifiedOutcomeEvidence,
  type VerifiedOutcomeInput,
  type WorkspaceStandard,
  type WorkspaceStandardInput
} from "../../../shared/frontend-experience.js";
import type { ExperienceStore } from "../../persistence/store.js";
import { appliesOutcomeToRecommendation } from "./outcome-verifier.js";

const governanceReviewSchema = z.object({
  action: z.enum(["verify", "recommend", "standardize", "reject", "deprecate", "supersede"]),
  workspaceId: z.string().min(1),
  experienceId: z.string().min(1),
  actorId: z.string().min(1),
  reason: z.string().trim().min(1).max(2_000),
  basisEvidenceIds: z.array(z.string().min(1)).min(1).max(100),
  decisionId: z.string().min(1).nullable(),
  supersededById: z.string().min(1).nullable()
}).strict().superRefine((value, context) => {
  if (value.action === "supersede" && value.supersededById === null) {
    context.addIssue({ code: "custom", path: ["supersededById"], message: "Superseding experience is required" });
  }
  if (value.action !== "supersede" && value.supersededById !== null) {
    context.addIssue({ code: "custom", path: ["supersededById"], message: "Supersession is only valid for supersede" });
  }
});

const userFeedbackSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  patternGroupId: z.string().min(1),
  evidenceId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
  event: experienceFeedbackEventSchema,
  currentProjectId: z.string().min(1),
  sourceVersion: z.string().min(1),
  taskSummary: z.string().trim().min(1).max(2_000)
}).strict();

export type GovernanceReviewInput = z.input<typeof governanceReviewSchema>;
export type ExperienceUserFeedbackInput = z.input<typeof userFeedbackSchema>;

const actionStates = {
  verify: "verified",
  recommend: "recommended",
  standardize: "standard",
  reject: "rejected",
  deprecate: "deprecated",
  supersede: "deprecated"
} as const;

export class FrontendExperienceGovernance {
  constructor(private readonly store: ExperienceStore) {}

  createDecision(input: DeclaredDecisionInput) {
    return this.store.createExperienceDecisionWithAudit(declaredDecisionInputSchema.parse(input));
  }

  async review(input: GovernanceReviewInput): Promise<ExperienceReviewEvent> {
    const parsed = governanceReviewSchema.parse(input);
    try {
      return await this.store.transitionExperienceWithAudit({
        workspaceId: parsed.workspaceId,
        patternGroupId: parsed.experienceId,
        to: actionStates[parsed.action],
        actorId: parsed.actorId,
        reason: parsed.reason,
        basisEvidenceIds: [...new Set(parsed.basisEvidenceIds)],
        decisionId: parsed.decisionId,
        supersededById: parsed.supersededById
      });
    } catch (error) {
      if (parsed.action === "recommend" && error instanceof Error
        && (error.message.includes("eligible evidence") || error.message.includes("basis"))) {
        throw new Error("Recommendation basis is incomplete or not visible", { cause: error });
      }
      throw error;
    }
  }

  createStandard(input: WorkspaceStandardInput): Promise<WorkspaceStandard> {
    return this.store.createWorkspaceStandardWithAudit(workspaceStandardInputSchema.parse(input));
  }

  async recordOutcome(input: VerifiedOutcomeInput): Promise<VerifiedOutcomeEvidence> {
    const parsed = verifiedOutcomeInputSchema.parse(input);
    const outcome = await this.store.recordExperienceOutcome(parsed);
    if (appliesOutcomeToRecommendation(outcome)) {
      await this.store.createExperienceReviewItem({
        id: randomUUID(), workspaceId: outcome.workspaceId, patternGroupId: outcome.patternGroupId,
        evidenceId: outcome.evidenceId, outcomeId: outcome.id, reportedBy: outcome.recordedBy,
        kind: "trusted_negative_outcome", priority: "high", feedbackEvent: null,
        currentProjectId: null, sourceVersion: outcome.sourceVersion,
        taskSummary: `${outcome.authority} reported ${outcome.outcome}`
      });
    }
    return outcome;
  }

  submitFeedback(input: ExperienceUserFeedbackInput): Promise<ExperienceReviewItem> {
    const parsed = userFeedbackSchema.parse(input);
    return this.store.createExperienceReviewItem({
      id: parsed.id, workspaceId: parsed.workspaceId, patternGroupId: parsed.patternGroupId,
      evidenceId: parsed.evidenceId, outcomeId: null, reportedBy: parsed.actorId,
      kind: "user_feedback", priority: "normal", feedbackEvent: parsed.event,
      currentProjectId: parsed.currentProjectId, sourceVersion: parsed.sourceVersion,
      taskSummary: parsed.taskSummary
    });
  }
}
