import { describe, expect, test } from "vitest";

import {
  EXPERIENCE_STATES,
  observedPatternEvidenceSchema,
  workspaceStandardSchema
} from "./frontend-experience";

describe("frontend experience contracts", () => {
  test("freezes lifecycle states and requires cited observed facts", () => {
    expect(EXPERIENCE_STATES).toEqual([
      "candidate", "verified", "recommended", "standard", "rejected", "deprecated"
    ]);
    expect(observedPatternEvidenceSchema.safeParse({
      id: "evidence-1",
      workspaceId: "workspace-1",
      patternGroupId: "group-1",
      projectId: "project-1",
      releaseId: "release-1",
      snapshotId: "snapshot-1",
      capability: "forms",
      sourceEligibility: "git",
      title: "Validated form handling",
      observedFact: "Uses explicit schema validation",
      profileDigest: "a".repeat(64),
      contentVersion: "content-1",
      citations: []
    }).success).toBe(false);
  });

  test("standards are workspace-authored and cannot self-supersede", () => {
    expect(workspaceStandardSchema.safeParse({
      id: "standard-1",
      workspaceId: "workspace-1",
      patternGroupId: "group-1",
      title: "Workspace standard",
      body: "Use the approved form boundary.",
      authoredBy: "admin-1",
      supersededById: "standard-1",
      createdAt: new Date()
    }).success).toBe(false);
  });
});
