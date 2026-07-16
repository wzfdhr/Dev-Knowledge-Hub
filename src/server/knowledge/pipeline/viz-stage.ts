import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import { graphEdgeSchema, graphNodeSchema, type ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import { exportKnowledgeGraph } from "./viz.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const graphArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema)
});

export interface KnowledgeVisualizationStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function knowledgeVisualizationPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "viz",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "viz-v1:mermaid-markmap",
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
    || run.stage !== "viz"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  ) throw new Error("Knowledge visualization stage does not match the project build and snapshot");
}

async function graphManifestForRun(store: KnowledgeVisualizationStageStore, run: PipelineStageRunRecord): Promise<ArtifactManifest> {
  const graphRun = (await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId))
    .findLast((candidate) => candidate.stage === "graph" && (candidate.status === "succeeded" || candidate.status === "reused"));
  if (!graphRun || graphRun.outputManifestIds.length !== 1) {
    throw new Error("Knowledge visualization stage requires exactly one completed graph artifact");
  }
  const manifest = await store.findArtifactById(graphRun.outputManifestIds[0]!);
  if (!manifest
    || manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.buildId !== run.buildId
    || manifest.stage !== "graph"
    || manifest.kind !== "knowledge-graph"
  ) throw new Error("Knowledge visualization graph artifact does not match the project build and snapshot");
  return manifest;
}

export function createKnowledgeVisualizationStageExecutor(input: {
  store: KnowledgeVisualizationStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge visualization snapshot is unavailable");
    const graphManifest = await graphManifestForRun(input.store, run);
    const inputDigest = knowledgeVisualizationPipelineInputDigest(snapshot, build.purpose, [graphManifest.id]);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge visualization input digest does not match the persisted graph artifact");
    }
    const graph = graphArtifactSchema.parse(await input.artifactStore.getJson(graphManifest));
    if (graph.snapshotId !== snapshot.id) throw new Error("Knowledge visualization graph artifact does not match the snapshot");
    const output = exportKnowledgeGraph({ nodes: graph.nodes, edges: graph.edges });
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId, snapshotId: run.snapshotId,
        buildId: run.buildId, stage: "viz", kind: "knowledge-visualization", schemaVersion: 1,
        inputDigest, contentDigest: "0".repeat(64), storageKey: "pending",
        sourceRefs: graph.nodes.flatMap((node) => node.sourceRefs), producer: "deterministic", createdAt: new Date().toISOString()
      },
      value: { schemaVersion: 1, snapshotId: snapshot.id, ...output },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
