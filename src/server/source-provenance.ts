import { createHash } from "node:crypto";

import type { SourceSnapshotRecord } from "./persistence/store.js";

export function remoteIdentityDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeSnapshotProvenance(
  snapshot: SourceSnapshotRecord
): SourceSnapshotRecord {
  const sourceKind = snapshot.sourceKind
    ?? (snapshot.ref === "upload" || snapshot.ref.startsWith("upload/") ? "upload" : "git");
  const contentVersion = snapshot.contentVersion ?? snapshot.commitSha;
  if (sourceKind === "upload") {
    const attestation = snapshot.attestation ?? "unverified";
    return {
      ...snapshot,
      sourceKind,
      gitCommitSha: null,
      contentVersion,
      attestation,
      linkedGitCommitSha: attestation === "git_linked" ? snapshot.linkedGitCommitSha ?? null : null,
      remoteIdentityDigest: attestation === "git_linked" ? snapshot.remoteIdentityDigest ?? null : null
    };
  }
  return {
    ...snapshot,
    sourceKind,
    gitCommitSha: snapshot.gitCommitSha ?? snapshot.commitSha,
    contentVersion,
    attestation: null,
    linkedGitCommitSha: null,
    remoteIdentityDigest: snapshot.remoteIdentityDigest
      ?? remoteIdentityDigest(snapshot.remoteUrl ?? `repository:${snapshot.repositoryId}`)
  };
}
