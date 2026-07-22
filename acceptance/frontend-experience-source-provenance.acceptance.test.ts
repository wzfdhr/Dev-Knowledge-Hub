import { expect, test } from "vitest";

import { queryExperienceProjection, type VisibleExperienceCandidate } from "../src/server/knowledge/frontend/experience-query";
import { linkUploadSnapshotToGit, sourceProvenanceForSnapshot } from "../src/server/source-provenance";

function snapshot(kind: "git" | "upload", contentVersion: string) {
  return {
    id: `snapshot-${kind}`, workspaceId: "workspace", repositoryId: `repository-${kind}`,
    commitSha: kind === "git" ? "a".repeat(40) : contentVersion,
    ref: kind === "git" ? "origin/main" : "upload", remoteUrl: kind === "git" ? "https://example.test/repo.git" : null,
    commitTimestamp: new Date(), storagePath: "/tmp/source", sourceKind: kind,
    gitCommitSha: kind === "git" ? "a".repeat(40) : null, contentVersion,
    attestation: kind === "upload" ? "unverified" as const : null,
    linkedGitCommitSha: null, remoteIdentityDigest: kind === "git" ? "b".repeat(64) : null
  };
}

test("Git linking requires a server-computed content identity match", () => {
  const upload = snapshot("upload", "content-a");
  const git = snapshot("git", "content-b");
  expect(() => linkUploadSnapshotToGit({ uploadSnapshot: upload as never, gitSnapshot: git as never }))
    .toThrow("content version does not match");

  const linked = linkUploadSnapshotToGit({
    uploadSnapshot: upload as never,
    gitSnapshot: { ...git, contentVersion: "content-a" } as never
  });
  const provenance = sourceProvenanceForSnapshot(linked, {
    id: "repository-upload", workspaceId: "workspace", projectId: "prior-project", kind: "upload"
  } as never);
  expect(provenance).toMatchObject({
    kind: "upload", gitCommitSha: null, contentVersion: "content-a",
    attestation: "git_linked", linkedGitCommitSha: "a".repeat(40)
  });
});

test("an admin-attested upload is eligible while an unverified upload is not", async () => {
  const makeCandidate = (sourceEligibility: "admin_attested" | "unverified_upload"): VisibleExperienceCandidate => ({
    experienceId: `experience-${sourceEligibility}`, capability: "form_validation", state: "recommended",
    supersededById: null, standards: [], outcomes: [],
    evidence: [{
      id: `evidence-${sourceEligibility}`, projectId: "prior-project", releaseId: "release-prior",
      sourceEligibility, title: "Prior form validation", observedFact: "Observed cited schema validation",
      contentVersion: "content-v1", citations: [{
        snapshotId: "snapshot-prior", path: "src/form.tsx", startLine: 1, endLine: 8,
        blobHash: "c".repeat(64)
      }],
      releasePublishedAt: new Date("2026-07-20T00:00:00.000Z"), fresh: true
    }],
    decisions: [{
      id: `decision-${sourceEligibility}`, decision: "approve",
      basisEvidenceIds: [`evidence-${sourceEligibility}`],
      applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] },
      createdAt: new Date("2026-07-21T00:00:00.000Z")
    }]
  });
  const result = await queryExperienceProjection({
    store: { listVisibleExperienceCandidates: async () => [
      makeCandidate("admin_attested"), makeCandidate("unverified_upload")
    ] },
    workspaceId: "workspace", userId: "member", currentProjectId: "current-project",
    currentProfile: {} as never, query: "form validation"
  });

  expect(result.applicableExperiences.map((item) => item.id)).toEqual(["experience-admin_attested"]);
  expect(result.rejectedExperiences).toEqual([{
    experienceId: "experience-unverified_upload", reasons: ["SOURCE_INELIGIBLE"]
  }]);
});
