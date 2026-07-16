import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import type { ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const validationArtifactSchema = z.object({ schemaVersion: z.literal(1), valid: z.literal(true) });
type PackageInputStage = "synthesize" | "index" | "lint" | "viz" | "validate";

export interface KnowledgePackageStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function knowledgePackagePipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "package",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "package-v1:immutable-candidate",
    purpose: {
      kind: purpose.kind,
      feedbackIds: purpose.feedbackIds,
      remediationIds: purpose.remediationContext?.map((context) => context.remediationId) ?? []
    }
  });
}

function assertOwnedBuild(run: PipelineStageRunRecord, build: BuildRecord | null, repository: RepositoryRecord | null, snapshot: SourceSnapshotRecord | null): asserts build is BuildRecord {
  if (!build || !repository || !snapshot || run.stage !== "package"
    || build.workspaceId !== run.workspaceId || build.id !== run.buildId
    || build.repositoryId !== repository.id || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId || snapshot.repositoryId !== build.repositoryId
  ) throw new Error("Knowledge package stage does not match the project build and snapshot");
}

async function upstreamManifests(store: KnowledgePackageStageStore, run: PipelineStageRunRecord): Promise<Record<PackageInputStage, ArtifactManifest>> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const requirements: Array<[PackageInputStage, string]> = [
    ["synthesize", "knowledge-pages"], ["index", "pipeline-search-index"], ["lint", "knowledge-quality"],
    ["viz", "knowledge-visualization"], ["validate", "pipeline-validation"]
  ];
  const entries = await Promise.all(requirements.map(async ([stage, kind]) => {
    const stageRun = runs.findLast((candidate) => candidate.stage === stage
      && (candidate.status === "succeeded" || candidate.status === "reused"));
    if (!stageRun || stageRun.outputManifestIds.length !== 1) {
      throw new Error(`Knowledge package stage requires exactly one completed ${stage} artifact`);
    }
    const manifest = await store.findArtifactById(stageRun.outputManifestIds[0]!);
    if (!manifest || manifest.workspaceId !== run.workspaceId || manifest.projectId !== run.projectId
      || manifest.snapshotId !== run.snapshotId
      || manifest.stage !== stage || manifest.kind !== kind
    ) throw new Error(`Knowledge package ${stage} artifact does not match the project build and snapshot`);
    return [stage, manifest] as const;
  }));
  return Object.fromEntries(entries) as Record<PackageInputStage, ArtifactManifest>;
}

export function createKnowledgePackageStageExecutor(input: {
  store: KnowledgePackageStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge package snapshot is unavailable");
    const upstream = await upstreamManifests(input.store, run);
    const inputDigest = knowledgePackagePipelineInputDigest(snapshot, build.purpose, [upstream.validate.id]);
    if (run.inputDigest !== inputDigest) throw new Error("Knowledge package input digest does not match the validation artifact");
    validationArtifactSchema.parse(await input.artifactStore.getJson(upstream.validate));
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId, snapshotId: run.snapshotId,
        buildId: run.buildId, stage: "package", kind: "pipeline-package", schemaVersion: 1,
        inputDigest, contentDigest: "0".repeat(64), storageKey: "pending",
        sourceRefs: upstream.synthesize.sourceRefs, producer: "deterministic", createdAt: new Date().toISOString()
      },
      value: {
        schemaVersion: 1, pipelineVersion: 1, workspaceId: run.workspaceId, projectId: run.projectId,
        snapshotId: run.snapshotId, buildId: run.buildId,
        artifacts: Object.fromEntries(Object.entries(upstream).map(([stage, manifest]) => [stage, manifest.id]))
      },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
