import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import type { ExperienceStore } from "../../persistence/store";
import { FrontendExperienceGovernance } from "./experience-governance";

function governanceStore(): ExperienceStore {
  return {
    saveObservedPatternEvidence: vi.fn(),
    createExperienceDecisionWithAudit: vi.fn(async (input) => ({ ...input, createdAt: new Date() })),
    recordExperienceOutcome: vi.fn(async (input) => ({ ...input, createdAt: new Date() })),
    transitionExperienceWithAudit: vi.fn(async (input) => ({
      id: randomUUID(), workspaceId: input.workspaceId, patternGroupId: input.patternGroupId,
      actorId: input.actorId, fromState: "verified" as const, toState: input.to, reason: input.reason,
      basisEvidenceIds: input.basisEvidenceIds, decisionId: input.decisionId, createdAt: new Date()
    })),
    listExperienceReviewEvents: vi.fn(async () => []),
    createExperienceReviewItem: vi.fn(async (input) => ({ ...input, createdAt: new Date() })),
    listExperienceReviewItems: vi.fn(async () => []),
    listExperienceLintRecords: vi.fn(async () => []),
    listVisibleExperienceCandidates: vi.fn(async () => []),
    createWorkspaceStandardWithAudit: vi.fn(async (input) => ({ ...input, createdAt: new Date() })),
    listExperienceProjection: vi.fn(async () => [])
  };
}

describe("frontend experience governance", () => {
  test("requires cited eligible evidence before approving a recommendation", async () => {
    const store = governanceStore();
    vi.mocked(store.transitionExperienceWithAudit).mockRejectedValueOnce(
      new Error("Recommended experience requires visible eligible evidence and an approved decision")
    );
    const governance = new FrontendExperienceGovernance(store);

    await expect(governance.review({
      action: "recommend", workspaceId: randomUUID(), experienceId: randomUUID(),
      actorId: randomUUID(), reason: "reviewed", basisEvidenceIds: [randomUUID()],
      decisionId: randomUUID(), supersededById: null
    })).rejects.toThrow("Recommendation basis is incomplete or not visible");
  });

  test("maps every administrator action to an audited lifecycle transition", async () => {
    const store = governanceStore();
    const governance = new FrontendExperienceGovernance(store);
    const base = {
      workspaceId: randomUUID(), experienceId: randomUUID(), actorId: randomUUID(),
      reason: "reviewed", basisEvidenceIds: [randomUUID()], decisionId: randomUUID(),
      supersededById: null
    };

    await governance.review({ ...base, action: "verify" });
    await governance.review({ ...base, action: "recommend" });
    await governance.review({ ...base, action: "standardize" });
    await governance.review({ ...base, action: "reject" });
    await governance.review({ ...base, action: "deprecate" });
    await governance.review({ ...base, action: "supersede", supersededById: randomUUID() });

    expect(vi.mocked(store.transitionExperienceWithAudit).mock.calls.map(([input]) => input.to))
      .toEqual(["verified", "recommended", "standard", "rejected", "deprecated", "deprecated"]);
  });

  test("trusted negative outcomes create high-priority review items", async () => {
    const store = governanceStore();
    const governance = new FrontendExperienceGovernance(store);
    const outcome = {
      id: randomUUID(), workspaceId: randomUUID(), patternGroupId: randomUUID(),
      evidenceId: randomUUID(), authority: "signed_ci" as const, outcome: "failed" as const,
      sourceVersion: "content-v1", checks: [{ name: "test", status: "failed" as const }],
      reportDigest: "a".repeat(64), recordedBy: randomUUID()
    };

    await governance.recordOutcome(outcome);

    expect(store.createExperienceReviewItem).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: outcome.workspaceId, patternGroupId: outcome.patternGroupId,
      evidenceId: outcome.evidenceId, outcomeId: outcome.id,
      kind: "trusted_negative_outcome", priority: "high"
    }));
  });

  test("ordinary user feedback creates a normal review item and cannot promote trust", async () => {
    const store = governanceStore();
    const governance = new FrontendExperienceGovernance(store);

    await governance.submitFeedback({
      id: randomUUID(), workspaceId: randomUUID(), patternGroupId: randomUUID(),
      evidenceId: randomUUID(), actorId: randomUUID(), event: "rolled_back",
      currentProjectId: randomUUID(), sourceVersion: "content-v1",
      taskSummary: "The integration was rolled back"
    });

    expect(store.recordExperienceOutcome).not.toHaveBeenCalled();
    expect(store.transitionExperienceWithAudit).not.toHaveBeenCalled();
    expect(store.createExperienceReviewItem).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user_feedback", priority: "normal", feedbackEvent: "rolled_back"
    }));
  });
});
