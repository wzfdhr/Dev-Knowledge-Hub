import { describe, expect, test, vi } from "vitest";

import type { ExperienceLintRecord } from "./experience-lint";
import { lintFrontendExperiences, runFrontendExperienceLint } from "./experience-lint";

const base: ExperienceLintRecord = {
  id: "group-a",
  state: "recommended",
  supersededById: null,
  evidence: [{
    id: "evidence-a", contentVersion: "content-v2", citations: [{
      snapshotId: "snapshot-a", path: "src/a.tsx", startLine: 1, endLine: 2,
      blobHash: "a".repeat(64)
    }], revokedAt: null, fresh: true
  }],
  decisions: [{
    id: "decision-a", decision: "approve", basisEvidenceIds: ["evidence-a"],
    applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] }
  }],
  outcomes: []
};

describe("frontend experience Knowledge Lint", () => {
  test("detects citation, basis, condition, version, lifecycle, and cycle failures", () => {
    const diagnostics = lintFrontendExperiences([
      {
        ...base,
        evidence: [{ ...base.evidence[0]!, citations: [], revokedAt: new Date(), fresh: false }],
        decisions: [{
          ...base.decisions[0]!, basisEvidenceIds: ["evidence-a", "missing-evidence"],
          applicability: {
            required: [{ key: "framework.name", operator: "equals", value: "react" }],
            forbidden: [{ key: "framework.name", operator: "equals", value: "react" }],
            preferred: [], unsupportedWhenUnknown: []
          }
        }],
        outcomes: [{
          id: "outcome-a", evidenceId: "evidence-a", sourceVersion: "content-v1",
          authority: "signed_ci", outcome: "rolled_back"
        }],
        supersededById: "group-b"
      },
      { ...base, id: "group-b", state: "deprecated", supersededById: "group-a" }
    ]);

    expect(new Set(diagnostics.map((item) => item.rule))).toEqual(new Set([
      "EXPERIENCE_CITATION_MISSING",
      "EXPERIENCE_BASIS_REVOKED",
      "EXPERIENCE_CONDITION_CONFLICT",
      "EXPERIENCE_EVIDENCE_STALE",
      "EXPERIENCE_OUTCOME_VERSION_MISMATCH",
      "EXPERIENCE_SIGNED_OUTCOME_FAILED",
      "EXPERIENCE_DEPRECATED_RECOMMENDATION",
      "EXPERIENCE_SUPERSESSION_CYCLE"
    ]));
    expect(diagnostics.filter((item) => item.severity === "error").length).toBeGreaterThanOrEqual(6);
  });

  test("queues high-severity diagnostics idempotently without changing experience content", async () => {
    const createExperienceReviewItem = vi.fn(async (input) => ({ ...input, createdAt: new Date() }));
    const store = {
      listExperienceLintRecords: vi.fn(async () => [{
        ...base, evidence: [{ ...base.evidence[0]!, citations: [] }]
      }]),
      createExperienceReviewItem
    };

    const first = await runFrontendExperienceLint(store, {
      workspaceId: "workspace-a", actorId: "admin-a"
    });
    const second = await runFrontendExperienceLint(store, {
      workspaceId: "workspace-a", actorId: "admin-a"
    });

    expect(first.diagnostics).toHaveLength(1);
    expect(first.reviewItemIds).toEqual(second.reviewItemIds);
    expect(createExperienceReviewItem).toHaveBeenCalledWith(expect.objectContaining({
      kind: "knowledge_lint", priority: "high", outcomeId: null,
      feedbackEvent: null, currentProjectId: null,
      patternGroupId: "group-a", evidenceId: "evidence-a"
    }));
    expect(store).not.toHaveProperty("transitionExperienceWithAudit");
  });
});
