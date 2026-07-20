import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { ArtifactManifest } from "./contracts.js";
import { canonicalJson, type ArtifactStore } from "./artifact-store.js";
import { convertSnapshotSourceFile } from "./convert.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { SourceBlobReader } from "./source-blob-reader.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const supportedExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".vue", ".html", ".css", ".scss", ".sass", ".less", ".svelte", ".astro", ".svg",
  ".md", ".json", ".yaml", ".yml"
]);
const referencedExtensions = new Set([...supportedExtensions, ".csv", ".xlsx"]);

export interface NormalizedSourcesStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<SourceFileRecord[]>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizedSourcesInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id" | "commitSha">,
  files: readonly Pick<SourceFileRecord, "path" | "byteSize" | "contentHash">[]
): string {
  return digest({
    schemaVersion: 1,
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    files: [...files].map((file) => ({
      path: file.path, byteSize: file.byteSize, contentHash: file.contentHash
    })).sort((left, right) => left.path.localeCompare(right.path))
  });
}

export function normalizedSourcesPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id" | "commitSha">,
  files: readonly Pick<SourceFileRecord, "path" | "byteSize" | "contentHash">[],
  purpose: BuildRecord["purpose"]
): string {
  return pipelineInputDigest({
    stage: "convert",
    snapshotId: snapshot.id,
    upstreamManifestIds: [],
    parserConfigVersion: `convert-v1:${normalizedSourcesInputDigest(snapshot, files)}`,
    purpose: {
      kind: purpose.kind,
      feedbackIds: purpose.feedbackIds,
      remediationIds: purpose.remediationContext?.map((context) => context.remediationId) ?? []
    }
  });
}

function ownsNormalizedSourcesStage(
  run: PipelineStageRunRecord,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "convert"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  );
}

function assertOwnedBuild(
  run: PipelineStageRunRecord,
  build: BuildRecord | null,
  repository: RepositoryRecord | null,
  snapshot: SourceSnapshotRecord | null
): asserts build is BuildRecord {
  if (!build || !repository || !snapshot || !ownsNormalizedSourcesStage(run, build, repository, snapshot)) {
    throw new Error("Normalized sources stage does not match the project build and snapshot");
  }
}

function isSupportedSourceFile(file: Pick<SourceFileRecord, "path">): boolean {
  return supportedExtensions.has(path.posix.extname(file.path).toLowerCase());
}

function isReferencedSourceFile(file: Pick<SourceFileRecord, "path">): boolean {
  return referencedExtensions.has(path.posix.extname(file.path).toLowerCase());
}

function lineCount(content: string): number {
  return Math.max(1, content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0));
}

function byteLineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return Math.max(1, lines + (bytes.at(-1) === 0x0a ? 0 : 1));
}

export function createNormalizedSourcesStageExecutor(input: {
  store: NormalizedSourcesStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
  sourceStorageMode?: "legacy" | "shadow" | "active";
  sourceBlobReader?: SourceBlobReader;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Normalized sources snapshot is unavailable");

    const files = await input.store.listSnapshotFiles(run.workspaceId, run.snapshotId);
    const inputDigest = normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Normalized sources stage input digest does not match the persisted snapshot");
    }
    const sourceStorageMode = input.sourceStorageMode ?? "legacy";
    let inlineArtifact: Awaited<ReturnType<ArtifactStore["putJson"]>> | undefined;
    if (sourceStorageMode !== "active") {
      const sources = await Promise.all(
        files.filter(isSupportedSourceFile)
          .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
          .map((file) => convertSnapshotSourceFile({ snapshot, file }))
      );
      const manifest: ArtifactManifest = {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "convert",
        kind: "normalized-sources",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: sources.map((source) => ({
          snapshotId: source.snapshotId,
          path: source.path,
          startLine: 1,
          endLine: lineCount(source.content),
          blobHash: source.blobHash
        })),
        producer: "deterministic",
        createdAt: new Date().toISOString()
      };
      inlineArtifact = await input.artifactStore.putJson({
        manifest,
        value: { schemaVersion: 1, snapshotId: snapshot.id, sources },
        actorId: input.actorId
      });
    }
    if (sourceStorageMode === "legacy") {
      return { outputManifestIds: [inlineArtifact!.manifest.id], reused: inlineArtifact!.reused };
    }

    const referencedFiles = files.filter(isReferencedSourceFile)
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
    if (referencedFiles.some((file) => !file.sourceBlobId)) {
      if (sourceStorageMode === "active") {
        throw new Error("Blob-backed source references require every pipeline source file to have a source blob");
      }
      return { outputManifestIds: [inlineArtifact!.manifest.id], reused: inlineArtifact!.reused };
    }
    if (!input.sourceBlobReader) throw new Error("Pipeline source blob reader is unavailable");
    const verifiedReferences = await Promise.all(referencedFiles.map(async (file) => {
      const reference = {
        snapshotId: snapshot.id,
        path: file.path,
        sourceBlobId: file.sourceBlobId!,
        blobHash: file.contentHash,
        byteSize: file.byteSize,
        language: file.language
      };
      const bytes = await input.sourceBlobReader!.read(run.workspaceId, reference);
      return {
        reference,
        endLine: path.posix.extname(reference.path).toLowerCase() === ".xlsx" ? 1 : byteLineCount(bytes)
      };
    }));
    const references = verifiedReferences.map(({ reference }) => reference);
    const referenceArtifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "convert",
        kind: "normalized-source-refs",
        schemaVersion: 2,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: verifiedReferences.map(({ reference, endLine }) => ({
          snapshotId: reference.snapshotId,
          path: reference.path,
          startLine: 1,
          endLine,
          blobHash: reference.blobHash
        })),
        producer: "deterministic",
        createdAt: new Date().toISOString()
      },
      value: { schemaVersion: 2, snapshotId: snapshot.id, sources: references },
      actorId: input.actorId
    });
    if (sourceStorageMode === "active") {
      return { outputManifestIds: [referenceArtifact.manifest.id], reused: referenceArtifact.reused };
    }
    return {
      outputManifestIds: [inlineArtifact!.manifest.id, referenceArtifact.manifest.id],
      reused: inlineArtifact!.reused && referenceArtifact.reused
    };
  };
}
