import { expect, test } from "vitest";

import { queryExperienceProjection, type VisibleExperienceCandidate } from "../src/server/knowledge/frontend/experience-query";

const evidence = {
  id: "evidence-rollback", projectId: "prior-project", releaseId: "release-prior",
  sourceEligibility: "git" as const, title: "Prior chart drilldown",
  observedFact: "Observed cited click handler", contentVersion: "content-v1",
  citations: [{
    snapshotId: "snapshot-prior", path: "src/chart.tsx", startLine: 4, endLine: 12,
    blobHash: "a".repeat(64)
  }],
  releasePublishedAt: new Date("2026-07-20T00:00:00.000Z"), fresh: true
};
const candidate: VisibleExperienceCandidate = {
  experienceId: "experience-rollback", capability: "chart_drilldown", state: "recommended",
  supersededById: null, evidence: [evidence], standards: [],
  decisions: [{
    id: "decision-1", decision: "approve", basisEvidenceIds: [evidence.id],
    applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] },
    createdAt: new Date("2026-07-21T00:00:00.000Z")
  }],
  outcomes: [{
    authority: "signed_ci", outcome: "rolled_back", evidenceId: evidence.id,
    sourceVersion: evidence.contentVersion
  }]
};

test("a trusted rollback immediately pauses the matching evidence version", async () => {
  const result = await queryExperienceProjection({
    store: { listVisibleExperienceCandidates: async () => [candidate] },
    workspaceId: "workspace", userId: "member", currentProjectId: "current-project",
    currentProfile: {
      framework: { state: "known", value: { name: "react", version: "19.2.0", supported: true } }
    } as never,
    query: "chart drilldown"
  });

  expect(result.applicableExperiences).toEqual([]);
  expect(result.rejectedExperiences).toEqual([{
    experienceId: candidate.experienceId,
    reasons: ["EVIDENCE_PAUSED"]
  }]);
});
