import { createHash, randomUUID } from "node:crypto";

import type { LintIssue } from "../../../shared/api-contracts.js";
import type { ArtifactManifest } from "./contracts.js";
import { canonicalJson, type ArtifactStore } from "./artifact-store.js";
import type { PipelineStageExecutor, PipelineStageJob } from "./worker.js";
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

function ownsQualityStage(
  run: PipelineStageRunRecord,
  job: PipelineStageJob,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "lint"
    || run.workspaceId !== job.workspaceId
    || run.projectId !== job.projectId
    || run.snapshotId !== job.snapshotId
    || run.buildId !== job.buildId
    || build.workspaceId !== job.workspaceId
    || build.id !== job.buildId
    || build.repositoryId !== repository?.id
    || build.snapshotId !== snapshot?.id
    || repository.workspaceId !== job.workspaceId
    || repository.projectId !== job.projectId
    || snapshot.workspaceId !== job.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  );
}

function assertOwnedBuild(
  run: PipelineStageRunRecord,
  job: PipelineStageJob,
  build: BuildRecord | null,
  repository: RepositoryRecord | null,
  snapshot: SourceSnapshotRecord | null
): asserts build is BuildRecord {
  if (!build || !repository || !snapshot) {
    throw new Error("Knowledge quality stage does not match the project build and snapshot");
  }
  if (!ownsQualityStage(run, job, build, repository, snapshot)) {
    throw new Error("Knowledge quality stage does not match the project build and snapshot");
  }
}

export function createKnowledgeQualityStageExecutor(input: {
  store: KnowledgeQualityStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run, job) => {
    const build = await input.store.getBuild(job.workspaceId, job.buildId);
    const repository = build ? await input.store.getRepository(job.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(job.workspaceId, job.snapshotId);
    assertOwnedBuild(run, job, build, repository, snapshot);
    if (!repository || !snapshot) throw new Error("Knowledge quality build is unavailable");

    const files = await input.store.listSnapshotFiles(job.workspaceId, job.snapshotId);
    const knowledgePageCount = await input.store.countKnowledgePagesForBuild(job.workspaceId, job.buildId);
    const inputDigest = knowledgeQualityInputDigest(snapshot, files, knowledgePageCount);
    if (job.inputDigest !== inputDigest || run.inputDigest !== inputDigest) {
      throw new Error("Knowledge quality stage input digest does not match the persisted snapshot");
    }
    const extracted = await extractSnapshotKnowledgeIR({ snapshot, files });
    const quality = assessKnowledgeQuality({
      buildId: build.id,
      projectId: job.projectId,
      ir: extracted.ir,
      knowledgePageCount,
      extractionIssues: extracted.lintIssues
    });
    const manifest: ArtifactManifest = {
      id: randomUUID(),
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      snapshotId: job.snapshotId,
      buildId: job.buildId,
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
    if (quality.graph.nodes.length > 0 && !await input.store.getKnowledgeGraph(job.workspaceId, job.projectId, job.buildId)) {
      await input.store.saveKnowledgeGraph({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        snapshotId: job.snapshotId,
        buildId: job.buildId,
        graph: quality.graph,
        actorId: input.actorId
      });
    }
    for (const issue of quality.issues) {
      if (issue.remediationState !== "open") continue;
      await input.store.createRemediation({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        repositoryId: build.repositoryId,
        sourceBuildId: build.id,
        issue
      });
    }
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
