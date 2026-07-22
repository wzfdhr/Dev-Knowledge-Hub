import { expect, test } from "vitest";

import { frontendProjectProfileDigest } from "../src/shared/frontend-project-profile";
import type { VisibleExperienceCandidate } from "../src/server/knowledge/frontend/experience-query";
import { buildSolutionContext } from "../src/server/mcp/workspace-tools";

const currentProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceRef = {
  snapshotId, path: "package.json", startLine: 1, endLine: 20, blobHash: "a".repeat(64)
};
const profilePayload = {
  schemaVersion: 1 as const,
  snapshotId,
  sourceProvenance: {
    schemaVersion: 1 as const, kind: "git" as const, gitCommitSha: "c".repeat(40),
    contentVersion: "d".repeat(40), ref: "main", remoteIdentityDigest: "e".repeat(64)
  },
  analyzerManifestDigest: "f".repeat(64),
  framework: { state: "known" as const, value: { name: "react", version: "19.2.0", supported: true } },
  rendering: { state: "known" as const, value: { modes: ["csr" as const] } },
  router: { state: "known" as const, value: { libraries: ["react-router"], routeCount: 12 } },
  state: { state: "known" as const, value: { libraries: ["zustand"], storeCount: 3 } },
  data: { state: "known" as const, value: { libraries: ["fetch"], operationCount: 18 } },
  formLibrary: { state: "known" as const, value: { libraries: ["react-hook-form"] } },
  tooling: { state: "known" as const, value: { buildTools: ["vite"], configs: ["vite.config.ts"] } },
  styles: { state: "known" as const, value: { systems: ["css-modules"], tokenCount: 8, componentLibraries: ["antd"] } },
  visualizations: { state: "known" as const, value: { libraries: ["echarts"], count: 4 } },
  tests: { state: "known" as const, value: { tools: ["vitest", "playwright"], kinds: ["unit", "e2e"], caseCount: 64 } },
  workspace: { state: "known" as const, value: { kind: "single-package" as const, packageManager: "npm" as const, packages: [""] } },
  sourceRefs: [sourceRef]
};
const profile = { ...profilePayload, profileDigest: frontendProjectProfileDigest(profilePayload) };
const packageValue = {
  schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId,
  analyzerManifestDigest: "f".repeat(64), upstreamManifestIds: ["validate-1", "validate-2"],
  sourceArtifactId: "package-source", irSchemaVersion: 2, graphSchemaVersion: 2,
  projectProfileArtifactId: "profile", projectProfileDigest: profile.profileDigest,
  patternCandidatesArtifactId: "patterns",
  artifacts: {
    convert: ["convert"], extract: ["extract-1", "extract-2"],
    tables: ["tables-1", "tables-2"], graph: ["graph-1", "graph-2"],
    synthesize: ["synth-1", "synth-2", "profile"], index: ["index-1", "index-2", "patterns"],
    lint: ["lint-1", "lint-2"], viz: ["viz-1", "viz-2"],
    validate: ["validate-1", "validate-2"], package: ["package-source"]
  }
};

function candidate(capability: VisibleExperienceCandidate["capability"]): VisibleExperienceCandidate {
  const id = `experience-${capability}`;
  const evidenceId = `evidence-${capability}`;
  return {
    experienceId: id,
    capability,
    state: "recommended",
    supersededById: null,
    evidence: [{
      id: evidenceId, projectId: `prior-${capability}`, releaseId: `release-${capability}`,
      sourceEligibility: "git", title: `Prior ${capability}`,
      observedFact: `Observed cited ${capability} implementation`, contentVersion: "prior-v1",
      citations: [{ ...sourceRef, snapshotId: `snapshot-${capability}`, path: `src/${capability}.tsx` }],
      releasePublishedAt: new Date("2026-07-20T00:00:00.000Z"), fresh: true
    }],
    decisions: [{
      id: `decision-${capability}`, decision: "approve", basisEvidenceIds: [evidenceId],
      applicability: {
        required: [{ key: "framework.name", operator: "equals", value: "react" }],
        forbidden: [], preferred: [], unsupportedWhenUnknown: []
      },
      createdAt: new Date("2026-07-21T00:00:00.000Z")
    }],
    outcomes: [], standards: []
  };
}

const goldenFlows = [
  ["chart drilldown", "chart_drilldown"],
  ["form validation", "form_validation"],
  ["state cache request", "state_data_flow"],
  ["component style token", "component_styling"],
  ["vitest playwright testing", "frontend_testing"]
] as const;

test.each(goldenFlows)("builds a partitioned solution context for %s", async (task, expectedCapability) => {
  const candidates = goldenFlows.map(([, capability]) => candidate(capability));
  const store = {
    projectAccess: async () => ({ project: { id: currentProjectId, archivedAt: null } }),
    currentRepository: async () => ({ id: "repository", projectId: currentProjectId }),
    currentRelease: async () => ({
      id: "release-current", snapshotId, releaseArtifactFamily: "frontend-v2",
      packageArtifactId: "package", publishedAt: new Date()
    }),
    findSnapshotById: async () => ({ id: snapshotId, contentVersion: "d".repeat(40), commitSha: "c".repeat(40) }),
    latestSnapshot: async () => ({ id: snapshotId }),
    findArtifactById: async (id: string) => ({ id }),
    listVisibleExperienceCandidates: async () => candidates
  };

  const result = await buildSolutionContext({
    context: {
      store: store as never, workspaceId: "workspace", userId: "member",
      scopes: ["workspace.solutions.read"],
      artifactReader: { getJson: async (manifest) => manifest.id === "package" ? packageValue : profile }
    },
    currentProjectId,
    task,
    changedPaths: ["src/feature.tsx"]
  });

  expect(result.schemaVersion).toBe(1);
  expect(result.currentProject.status).toBe("ready");
  expect(result.applicableExperiences).toHaveLength(5);
  expect(result.applicableExperiences[0]?.capability).toBe(expectedCapability);
  expect(result.applicableExperiences.every((item) => item.citations.length > 0)).toBe(true);
  expect(result.currentProjectFacts.length).toBeGreaterThan(0);
  expect(result.hardConstraints.length).toBeGreaterThan(0);
  expect(result.rejectedExperiences).toEqual([]);
  expect(result.changeImpact).toEqual([expect.objectContaining({ path: "src/feature.tsx" })]);
  expect(result.verificationPlan).toHaveLength(2);
});
