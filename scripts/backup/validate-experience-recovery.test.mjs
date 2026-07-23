import assert from "node:assert/strict";
import test from "node:test";

import { validateExperienceRecoveryEvidence } from "./validate-experience-recovery.mjs";

const digest = "a".repeat(64);

function recoveryFixture() {
  return {
    restoredDatabase: {
      sourceSnapshots: [{
        id: "snapshot-1", workspaceId: "workspace-1", sourceKind: "git",
        gitCommitSha: "b".repeat(40), contentVersion: "content-v1", attestation: null,
        linkedGitCommitSha: null, remoteIdentityDigest: digest
      }],
      releases: [{
        id: "release-1", workspaceId: "workspace-1", snapshotId: "snapshot-1",
        projectProfileArtifactId: "profile-1"
      }],
      projectProfiles: [{
        artifactId: "profile-1", workspaceId: "workspace-1", snapshotId: "snapshot-1",
        profileDigest: digest, contentDigest: digest
      }],
      patternGroups: [{ id: "group-1", workspaceId: "workspace-1", supersededById: null }],
      evidence: [{
        id: "evidence-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        releaseId: "release-1", snapshotId: "snapshot-1", profileDigest: digest,
        contentVersion: "content-v1", citationSnapshotIds: ["snapshot-1"]
      }],
      decisions: [{
        id: "decision-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        basisEvidenceIds: ["evidence-1"]
      }],
      outcomes: [{
        id: "outcome-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        evidenceId: "evidence-1", sourceVersion: "content-v1"
      }],
      reviews: [{
        id: "review-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        basisEvidenceIds: ["evidence-1"], decisionId: "decision-1"
      }],
      reviewItems: [{
        id: "review-item-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        evidenceId: "evidence-1", outcomeId: "outcome-1", sourceVersion: "content-v1"
      }],
      standards: [{
        id: "standard-1", workspaceId: "workspace-1", patternGroupId: "group-1",
        supersededById: null
      }]
    },
    restoredArtifacts: [{
      id: "profile-1", snapshotId: "snapshot-1", kind: "frontend-project-profile",
      contentDigest: digest, payloadDigest: digest
    }]
  };
}

test("rejects recovery evidence when an experience review basis references a missing release", () => {
  const fixture = recoveryFixture();
  fixture.restoredDatabase.releases = [];

  const result = validateExperienceRecoveryEvidence(fixture);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /experience review basis release missing/);
});

test("accepts a complete source, profile, evidence, governance and release graph", () => {
  const result = validateExperienceRecoveryEvidence(recoveryFixture());

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.counts, {
    sourceSnapshots: 1, releases: 1, projectProfiles: 1, patternGroups: 1,
    evidence: 1, decisions: 1, outcomes: 1, reviews: 1, reviewItems: 1,
    standards: 1, artifacts: 1
  });
});

test("rejects profile artifact digest drift and standard supersession cycles", () => {
  const fixture = recoveryFixture();
  fixture.restoredArtifacts[0].payloadDigest = "c".repeat(64);
  fixture.restoredDatabase.standards = [
    { id: "standard-1", workspaceId: "workspace-1", patternGroupId: "group-1", supersededById: "standard-2" },
    { id: "standard-2", workspaceId: "workspace-1", patternGroupId: "group-1", supersededById: "standard-1" }
  ];

  const result = validateExperienceRecoveryEvidence(fixture);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /project profile artifact digest mismatch/);
  assert.match(result.errors.join("\n"), /workspace standard supersession cycle/);
});
