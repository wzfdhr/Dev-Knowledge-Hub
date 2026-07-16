import { createHash, randomUUID } from "node:crypto";

import type { LintIssue } from "../../../shared/api-contracts.js";
import type { ArtifactManifest } from "./contracts.js";
import { canonicalJson, type ArtifactStore } from "./artifact-store.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import { extractSnapshotKnowledgeIR } from "../intelligence.js";
import { assessKnowledgeQuality } from "../quality-assessment.js";
import type {
  GraphStore,
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RemediationRecord,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

export interface KnowledgeQualityStageStore extends PipelineArtifactStore, GraphStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<SourceFileRecord[]>;
  countKnowledgePagesForBuild(workspaceId: string, buildId: string): Promise<number>;
  createRemediation(input: {
    workspaceId: string;
    projectId: string;
    repositoryId: string;
    sourceBuildId: string;
    issue: LintIssue;
  }): Promise<RemediationRecord>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function knowledgeQualityInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id" | "commitSha">,
  files: readonly Pick<SourceFileRecord, "path" | "byteSize" | "contentHash">[],
  knowledgePageCount = 0
): string {
  return digest({
    schemaVersion: 1,
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    knowledgePageCount,
    files: [...files].map((file) => ({
      path: file.path, byteSize: file.byteSize, contentHash: file.contentHash
    })).sort((left, right) => left.path.localeCompare(right.path))
  });
}

export function knowledgeQualityPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id" | "commitSha">,
  files: readonly Pick<SourceFileRecord, "path" | "byteSize" | "contentHash">[],
  purpose: BuildRecord["purpose"],
  knowledgePageCount = 0
): string {
  return pipelineInputDigest({
    stage: "lint",
    snapshotId: snapshot.id,
    upstreamManifestIds: [],
    parserConfigVersion: `quality-v1:${knowledgeQualityInputDigest(snapshot, files, knowledgePageCount)}`,
    purpose: {
      kind: purpose.kind,
      feedbackIds: purpose.feedbackIds,
      remediationIds: purpose.remediationContext?.map((context) => context.remediationId) ?? []
    }
  });
}

function ownsQualityStage(
  run: PipelineStageRunRecord,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "lint"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository?.id
    || build.snapshotId !== snapshot?.id
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
  if (!build || !repository || !snapshot) {
    throw new Error("Knowledge quality stage does not match the project build and snapshot");
  }
  if (!ownsQualityStage(run, build, repository, snapshot)) {
    throw new Error("Knowledge quality stage does not match the project build and snapshot");
  }
}

export function createKnowledgeQualityStageExecutor(input: {
  store: KnowledgeQualityStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!repository || !snapshot) throw new Error("Knowledge quality build is unavailable");

    const files = await input.store.listSnapshotFiles(run.workspaceId, run.snapshotId);
    const knowledgePageCount = await input.store.countKnowledgePagesForBuild(run.workspaceId, run.buildId);
    const inputDigest = knowledgeQualityPipelineInputDigest(snapshot, files, build.purpose, knowledgePageCount);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge quality stage input digest does not match the persisted snapshot");
    }
    const extracted = await extractSnapshotKnowledgeIR({ snapshot, files });
    const quality = assessKnowledgeQuality({
      buildId: build.id,
      projectId: run.projectId,
      ir: extracted.ir,
      knowledgePageCount,
      extractionIssues: extracted.lintIssues
    });
    const manifest: ArtifactManifest = {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      snapshotId: run.snapshotId,
      buildId: run.buildId,
      stage: "lint",
      kind: "knowledge-quality",
      schemaVersion: 1,
      inputDigest,
      contentDigest: "0".repeat(64),
      storageKey: "pending",
      sourceRefs: quality.graph.nodes.flatMap((node) => node.sourceRefs),
      producer: "deterministic",
      createdAt: new Date().toISOString()
    };
    const artifact = await input.artifactStore.putJson({
      manifest,
      value: { schemaVersion: 1, ir: extracted.ir, ...quality },
      actorId: input.actorId
    });
    if (quality.graph.nodes.length > 0 && !await input.store.getKnowledgeGraph(run.workspaceId, run.projectId, run.buildId)) {
      await input.store.saveKnowledgeGraph({
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        graph: quality.graph,
        actorId: input.actorId
      });
    }
    for (const issue of quality.issues) {
      if (issue.remediationState !== "open") continue;
      await input.store.createRemediation({
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        repositoryId: build.repositoryId,
        sourceBuildId: build.id,
        issue
      });
    }
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
