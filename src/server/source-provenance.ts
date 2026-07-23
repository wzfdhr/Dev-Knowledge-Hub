import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";

import type { RepositoryRecord, SourceSnapshotRecord } from "./persistence/store.js";

export type UploadAttestation = "unverified" | "admin_attested" | "git_linked";

export type SourceProvenance =
  | {
      schemaVersion: 1;
      kind: "git";
      gitCommitSha: string;
      contentVersion: string;
      ref: string;
      remoteIdentityDigest: string;
    }
  | {
      schemaVersion: 1;
      kind: "upload";
      gitCommitSha: null;
      contentVersion: string;
      ref: "upload";
      attestation: UploadAttestation;
      linkedGitCommitSha?: string;
      remoteIdentityDigest?: string;
    };

export function updateContentVersion(
  hash: Hash,
  filePath: string,
  content: Buffer
): void {
  const pathBytes = Buffer.from(filePath, "utf8");
  hash.update(`${pathBytes.length}:`);
  hash.update(pathBytes);
  hash.update(`:${content.length}:`);
  hash.update(content);
}

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

export function sourceProvenanceForSnapshot(
  snapshot: SourceSnapshotRecord,
  repository: RepositoryRecord
): SourceProvenance {
  const normalized = normalizeSnapshotProvenance(snapshot);
  if (repository.kind === "upload") {
    if (normalized.sourceKind !== "upload" || !normalized.contentVersion || !normalized.attestation) {
      throw new Error("Upload snapshot provenance is incomplete");
    }
    if (normalized.attestation === "git_linked"
      && (!normalized.linkedGitCommitSha || !normalized.remoteIdentityDigest)) {
      throw new Error("Git-linked upload provenance is incomplete");
    }
    return {
      schemaVersion: 1,
      kind: "upload",
      gitCommitSha: null,
      contentVersion: normalized.contentVersion,
      ref: "upload",
      attestation: normalized.attestation,
      ...(normalized.linkedGitCommitSha ? { linkedGitCommitSha: normalized.linkedGitCommitSha } : {}),
      ...(normalized.remoteIdentityDigest ? { remoteIdentityDigest: normalized.remoteIdentityDigest } : {})
    };
  }
  if (normalized.sourceKind !== "git" || !normalized.gitCommitSha
    || !normalized.contentVersion || !normalized.remoteIdentityDigest) {
    throw new Error("Git snapshot provenance is incomplete");
  }
  return {
    schemaVersion: 1,
    kind: "git",
    gitCommitSha: normalized.gitCommitSha,
    contentVersion: normalized.contentVersion,
    ref: normalized.ref,
    remoteIdentityDigest: normalized.remoteIdentityDigest
  };
}

export function sourceProvenanceForSnapshotIdentity(
  snapshot: SourceSnapshotRecord
): SourceProvenance {
  const normalized = normalizeSnapshotProvenance(snapshot);
  if (normalized.sourceKind === "upload") {
    if (!normalized.contentVersion || !normalized.attestation) {
      throw new Error("Upload snapshot provenance is incomplete");
    }
    if (normalized.attestation === "git_linked"
      && (!normalized.linkedGitCommitSha || !normalized.remoteIdentityDigest)) {
      throw new Error("Git-linked upload provenance is incomplete");
    }
    return {
      schemaVersion: 1,
      kind: "upload",
      gitCommitSha: null,
      contentVersion: normalized.contentVersion,
      ref: "upload",
      attestation: normalized.attestation,
      ...(normalized.linkedGitCommitSha ? { linkedGitCommitSha: normalized.linkedGitCommitSha } : {}),
      ...(normalized.remoteIdentityDigest ? { remoteIdentityDigest: normalized.remoteIdentityDigest } : {})
    };
  }
  if (!normalized.gitCommitSha || !normalized.contentVersion || !normalized.remoteIdentityDigest) {
    throw new Error("Git snapshot provenance is incomplete");
  }
  return {
    schemaVersion: 1,
    kind: "git",
    gitCommitSha: normalized.gitCommitSha,
    contentVersion: normalized.contentVersion,
    ref: normalized.ref,
    remoteIdentityDigest: normalized.remoteIdentityDigest
  };
}

export function linkUploadSnapshotToGit({
  uploadSnapshot,
  gitSnapshot
}: {
  uploadSnapshot: SourceSnapshotRecord;
  gitSnapshot: SourceSnapshotRecord;
}): SourceSnapshotRecord {
  const upload = normalizeSnapshotProvenance(uploadSnapshot);
  const git = normalizeSnapshotProvenance(gitSnapshot);
  if (upload.sourceKind !== "upload" || git.sourceKind !== "git") {
    throw new Error("Source kinds are not eligible for Git linking");
  }
  if (upload.contentVersion !== git.contentVersion) {
    throw new Error("Upload content version does not match the Git snapshot");
  }
  if (!git.gitCommitSha || !git.remoteIdentityDigest) {
    throw new Error("Git snapshot provenance is incomplete");
  }
  return {
    ...upload,
    attestation: "git_linked",
    linkedGitCommitSha: git.gitCommitSha,
    remoteIdentityDigest: git.remoteIdentityDigest
  };
}
