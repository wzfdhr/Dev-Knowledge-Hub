import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import { lintIssueSchema, trustScoreSchema, type ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import { validateKnowledge, type KnowledgeOutput } from "../generator.js";
import type { CodeIndex } from "../intelligence.js";
import type {
  PipelineArtifactStore,
  PipelineSearchDocumentStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const synthesisArtifactSchema = z.object({ schemaVersion: z.literal(1), index: z.unknown(), output: z.unknown() });
const qualityArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  issues: z.array(lintIssueSchema),
  trust: trustScoreSchema
});
const visualizationArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  mermaid: z.string().min(1),
  markmap: z.string().min(1),
  graph: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) })
});

type ValidationUpstreamStage = "synthesize" | "index" | "lint" | "viz";

export interface KnowledgeValidationStageStore extends PipelineArtifactStore, PipelineSearchDocumentStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function knowledgeValidationPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "validate",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "validate-v1:references-quality-viz",
    purpose: {
      kind: purpose.kind,
      feedbackIds: purpose.feedbackIds,
      remediationIds: purpose.remediationContext?.map((context) => context.remediationId) ?? []
    }
  });
}

function assertOwnedBuild(
  run: PipelineStageRunRecord,
  build: BuildRecord | null,
  repository: RepositoryRecord | null,
  snapshot: SourceSnapshotRecord | null
): asserts build is BuildRecord {
  if (!build || !repository || !snapshot
    || run.stage !== "validate"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  ) throw new Error("Knowledge validation stage does not match the project build and snapshot");
}

async function upstreamManifests(
  store: KnowledgeValidationStageStore,
  run: PipelineStageRunRecord
): Promise<Record<ValidationUpstreamStage, ArtifactManifest>> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const requirements: Array<[ValidationUpstreamStage, string]> = [
    ["synthesize", "knowledge-pages"], ["index", "pipeline-search-index"],
    ["lint", "knowledge-quality"], ["viz", "knowledge-visualization"]
  ];
  const entries = await Promise.all(requirements.map(async ([stage, kind]) => {
    const stageRun = runs.findLast((candidate) => candidate.stage === stage
      && (candidate.status === "succeeded" || candidate.status === "reused"));
    if (!stageRun || stageRun.outputManifestIds.length !== 1) {
      throw new Error(`Knowledge validation stage requires exactly one completed ${stage} artifact`);
    }
    const manifest = await store.findArtifactById(stageRun.outputManifestIds[0]!);
    if (!manifest
      || manifest.workspaceId !== run.workspaceId
      || manifest.projectId !== run.projectId
      || manifest.snapshotId !== run.snapshotId
      || manifest.stage !== stage
      || manifest.kind !== kind
    ) throw new Error(`Knowledge validation ${stage} artifact does not match the project build and snapshot`);
    return [stage, manifest] as const;
  }));
  return Object.fromEntries(entries) as Record<ValidationUpstreamStage, ArtifactManifest>;
}

export function createKnowledgeValidationStageExecutor(input: {
  store: KnowledgeValidationStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge validation snapshot is unavailable");
    const upstream = await upstreamManifests(input.store, run);
    const upstreamManifestIds = [upstream.synthesize.id, upstream.index.id, upstream.lint.id, upstream.viz.id];
    const inputDigest = knowledgeValidationPipelineInputDigest(snapshot, build.purpose, upstreamManifestIds);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge validation input digest does not match the persisted pipeline artifacts");
    }
    const [synthesis, quality, visualization] = await Promise.all([
      input.artifactStore.getJson(upstream.synthesize).then((value) => synthesisArtifactSchema.parse(value)),
      input.artifactStore.getJson(upstream.lint).then((value) => qualityArtifactSchema.parse(value)),
      input.artifactStore.getJson(upstream.viz).then((value) => visualizationArtifactSchema.parse(value))
    ]);
    validateKnowledge(synthesis.output as KnowledgeOutput, synthesis.index as CodeIndex);
    if (quality.issues.some((issue) => issue.severity === "error")) {
      throw new Error("Knowledge validation found blocking lint errors");
    }
    if (visualization.snapshotId !== snapshot.id) {
      throw new Error("Knowledge validation visualization does not match the snapshot");
    }
    const documents = await input.store.listPipelineSearchDocuments(run.workspaceId, run.projectId, run.buildId);
    if (!documents.length || documents.some((document) => document.sourceArtifactId !== upstream.synthesize.id)) {
      throw new Error("Knowledge validation search documents do not match the knowledge pages artifact");
    }
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId, snapshotId: run.snapshotId,
        buildId: run.buildId, stage: "validate", kind: "pipeline-validation", schemaVersion: 1,
        inputDigest, contentDigest: "0".repeat(64), storageKey: "pending",
        sourceRefs: upstream.synthesize.sourceRefs, producer: "deterministic", createdAt: new Date().toISOString()
      },
      value: {
        schemaVersion: 1,
        valid: true,
        upstreamManifestIds,
        lintIssueCount: quality.issues.length,
        trust: quality.trust,
        documentCount: documents.length
      },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
