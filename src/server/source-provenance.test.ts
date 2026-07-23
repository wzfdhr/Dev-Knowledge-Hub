import { describe, expect, test } from "vitest";

import type { RepositoryRecord, SourceSnapshotRecord } from "./persistence/store";
import {
  linkUploadSnapshotToGit,
  sourceProvenanceForSnapshot
} from "./source-provenance";

const baseRepository: RepositoryRecord = {
  id: "repository-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  kind: "upload",
  name: "Uploaded source",
  localPath: null,
  cloneUrl: null,
  defaultBranch: "main",
  archivedAt: null,
  hasCredential: false
};

const baseSnapshot: SourceSnapshotRecord = {
  id: "snapshot-1",
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  commitSha: "legacy-content-version",
  ref: "upload/legacy-content-version",
  remoteUrl: null,
  commitTimestamp: new Date("2026-07-22T00:00:00.000Z"),
  storagePath: "/tmp/snapshot",
  sourceKind: "upload",
  gitCommitSha: null,
  contentVersion: "content-version-1",
  attestation: "unverified",
  linkedGitCommitSha: null,
  remoteIdentityDigest: null
};

describe("source provenance", () => {
  test("keeps an upload content version out of gitCommitSha", () => {
    expect(sourceProvenanceForSnapshot(baseSnapshot, baseRepository)).toEqual({
      schemaVersion: 1,
      kind: "upload",
      gitCommitSha: null,
      contentVersion: "content-version-1",
      ref: "upload",
      attestation: "unverified"
    });
  });

  test("returns explicit Git commit and content identities", () => {
    const repository = { ...baseRepository, kind: "git" as const, cloneUrl: "https://example.test/team/repo.git" };
    const snapshot = {
      ...baseSnapshot,
      sourceKind: "git" as const,
      gitCommitSha: "a".repeat(40),
      commitSha: "a".repeat(40),
      contentVersion: "content-version-1",
      ref: "origin/main",
      attestation: null,
      remoteIdentityDigest: "remote-digest"
    };

    expect(sourceProvenanceForSnapshot(snapshot, repository)).toEqual({
      schemaVersion: 1,
      kind: "git",
      gitCommitSha: "a".repeat(40),
      contentVersion: "content-version-1",
      ref: "origin/main",
      remoteIdentityDigest: "remote-digest"
    });
  });

  test("requires matching normalized content before linking an upload to Git", () => {
    const gitSnapshot = {
      ...baseSnapshot,
      id: "git-snapshot",
      sourceKind: "git" as const,
      gitCommitSha: "b".repeat(40),
      contentVersion: "different-version",
      attestation: null,
      remoteIdentityDigest: "remote-digest"
    };

    expect(() => linkUploadSnapshotToGit({ uploadSnapshot: baseSnapshot, gitSnapshot }))
      .toThrow("Upload content version does not match the Git snapshot");
  });
});
