import { describe, expect, test, vi } from "vitest";

import { queryExperienceProjection, type VisibleExperienceCandidate } from "./experience-query";

const citedEvidence = {
  id: "evidence-1", projectId: "prior-project", releaseId: "release-1",
  sourceEligibility: "git" as const, title: "Vue chart drilldown",
  observedFact: "Uses a cited click-to-route drilldown", contentVersion: "content-v1",
  citations: [{
    snapshotId: "snapshot-1", path: "src/chart.tsx", startLine: 1, endLine: 4,
    blobHash: "a".repeat(64)
  }],
  releasePublishedAt: new Date("2026-07-20T00:00:00.000Z"), fresh: true
};

function candidate(input: Partial<VisibleExperienceCandidate> = {}): VisibleExperienceCandidate {
  return {
    experienceId: "experience-vue", capability: "chart_drilldown", state: "recommended",
    supersededById: null, evidence: [citedEvidence], outcomes: [], standards: [],
    decisions: [{
      id: "decision-1", decision: "approve", basisEvidenceIds: [citedEvidence.id],
      applicability: {
        required: [{ key: "framework.name", operator: "equals", value: "vue" }],
        forbidden: [], preferred: [], unsupportedWhenUnknown: []
      },
      createdAt: new Date("2026-07-21T00:00:00.000Z")
    }],
    ...input
  };
}

function profile(framework: "react" | "vue" | "unknown") {
  return {
    profileDigest: "b".repeat(64),
    framework: framework === "unknown"
      ? { state: "unknown", reason: "unresolved" }
      : { state: "known", value: { name: framework, version: "19.0.0", supported: true } },
    rendering: { state: "known", value: { modes: ["csr"] } },
    tooling: { state: "known", value: { buildTools: ["vite"], configs: [] } }
  } as never;
}

describe("experience applicability query", () => {
  test("rejects Vue evidence for a React project before text ranking", async () => {
    const store = { listVisibleExperienceCandidates: vi.fn(async () => [candidate()]) };

    const result = await queryExperienceProjection({
      store, workspaceId: "workspace-1", userId: "user-1", currentProjectId: "current-project",
      currentProfile: profile("react"), query: "图表下钻"
    });

    expect(result.applicableExperiences.map((item) => item.id)).not.toContain("experience-vue");
    expect(result.rejectedExperiences).toContainEqual({
      experienceId: "experience-vue", reasons: ["FRAMEWORK_MISMATCH"]
    });
  });

  test("rejects a recommendation when a critical current-project attribute is unknown", async () => {
    const requiringKnownFramework = candidate({
      decisions: [{
        ...candidate().decisions[0]!,
        applicability: {
          required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: ["framework.name"]
        }
      }]
    });
    const result = await queryExperienceProjection({
      store: { listVisibleExperienceCandidates: vi.fn(async () => [requiringKnownFramework]) },
      workspaceId: "workspace-1", userId: "user-1", currentProjectId: "current-project",
      currentProfile: profile("unknown"), query: "chart"
    });

    expect(result.applicableExperiences).toEqual([]);
    expect(result.rejectedExperiences[0]?.reasons).toEqual(["REQUIRED_ATTRIBUTE_UNKNOWN"]);
  });

  test("ranks only hard-filtered experiences using visible evidence", async () => {
    const react = candidate({
      experienceId: "experience-react", evidence: [{ ...citedEvidence, title: "React chart drilldown" }],
      decisions: [{
        ...candidate().decisions[0]!, id: "decision-react",
        applicability: {
          required: [{ key: "framework.name", operator: "equals", value: "react" }],
          forbidden: [], preferred: [{ key: "tooling.buildTools", operator: "includes", value: "vite" }],
          unsupportedWhenUnknown: []
        }
      }],
      outcomes: [{ authority: "signed_ci", outcome: "passed", evidenceId: citedEvidence.id,
        sourceVersion: "content-v1" }]
    });
    const result = await queryExperienceProjection({
      store: { listVisibleExperienceCandidates: vi.fn(async () => [candidate(), react]) },
      workspaceId: "workspace-1", userId: "user-1", currentProjectId: "current-project",
      currentProfile: profile("react"), query: "chart drilldown"
    });

    expect(result.applicableExperiences.map((item) => item.id)).toEqual(["experience-react"]);
    expect(result.applicableExperiences[0]).toMatchObject({
      evidenceCount: 1, observedFacts: ["Uses a cited click-to-route drilldown"]
    });
    expect(result.visibleReleaseIds).toEqual(["release-1"]);
  });
});
