import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import {
  knowledgeIrSchema,
  tableSchemaSchema,
  type ArtifactManifest,
  type KnowledgeIR
} from "./contracts.js";
import { buildKnowledgeGraph, validateKnowledgeGraph } from "./graph.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  GraphStore,
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const tableSchemasArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  tables: z.array(tableSchemaSchema)
});

type GraphUpstreamStage = "extract" | "tables";

export interface KnowledgeGraphStageStore extends PipelineArtifactStore, GraphStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function knowledgeGraphPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "graph",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "pipeline-v1",
    purpose: {
      kind: purpose.kind,
      feedbackIds: purpose.feedbackIds,
      remediationIds: purpose.remediationContext?.map((context) => context.remediationId) ?? []
    }
  });
}

function ownsGraphStage(
  run: PipelineStageRunRecord,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "graph"
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
  if (!build || !repository || !snapshot || !ownsGraphStage(run, build, repository, snapshot)) {
    throw new Error("Knowledge graph stage does not match the project build and snapshot");
  }
}

function assertOwnedUpstreamRun(
  run: PipelineStageRunRecord,
  upstream: PipelineStageRunRecord,
  stage: GraphUpstreamStage
): void {
  if (
    upstream.stage !== stage
    || upstream.workspaceId !== run.workspaceId
    || upstream.projectId !== run.projectId
    || upstream.snapshotId !== run.snapshotId
    || upstream.buildId !== run.buildId
  ) {
    throw new Error(`Knowledge graph ${stage} run does not match the project build and snapshot`);
  }
}

function assertOwnedUpstreamManifest(
  run: PipelineStageRunRecord,
  manifest: ArtifactManifest,
  stage: GraphUpstreamStage,
  kind: "knowledge-ir" | "table-schemas"
): void {
  if (
    manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.buildId !== run.buildId
    || manifest.stage !== stage
    || manifest.kind !== kind
  ) {
    throw new Error(`Knowledge graph ${stage} manifest does not match the project build and snapshot`);
  }
}

function upstreamManifestId(
  run: PipelineStageRunRecord,
  stageRuns: readonly PipelineStageRunRecord[],
  stage: GraphUpstreamStage
): string {
  const runs = stageRuns.filter((candidate) => candidate.stage === stage);
  if (runs.length === 0) throw new Error(`Knowledge graph stage requires a ${stage} run`);
  const completed = runs.findLast((candidate) => candidate.status === "succeeded" || candidate.status === "reused");
  if (!completed) throw new Error(`Knowledge graph stage requires a succeeded or reused ${stage} run`);
  assertOwnedUpstreamRun(run, completed, stage);
  if (completed.outputManifestIds.length !== 1) {
    throw new Error(`Knowledge graph stage requires exactly one ${stage} manifest`);
  }
  return completed.outputManifestIds[0]!;
}

async function ownedManifest(
  store: KnowledgeGraphStageStore,
  run: PipelineStageRunRecord,
  artifactId: string,
  stage: GraphUpstreamStage,
  kind: "knowledge-ir" | "table-schemas"
): Promise<ArtifactManifest> {
  const manifest = await store.findArtifactById(artifactId);
  if (!manifest) throw new Error(`Knowledge graph ${stage} manifest is unavailable`);
  assertOwnedUpstreamManifest(run, manifest, stage, kind);
  return manifest;
}

function knowledgeIrFromArtifact(manifest: ArtifactManifest, value: unknown): KnowledgeIR {
  const ir = knowledgeIrSchema.parse(value);
  if (ir.snapshotId !== manifest.snapshotId) {
    throw new Error("Knowledge graph knowledge IR artifact does not match its snapshot");
  }
  return ir;
}

function tablesFromArtifact(manifest: ArtifactManifest, value: unknown) {
  const artifact = tableSchemasArtifactSchema.parse(value);
  if (artifact.snapshotId !== manifest.snapshotId) {
    throw new Error("Knowledge graph table schemas artifact does not match its snapshot");
  }
  return artifact.tables;
}

export function createKnowledgeGraphStageExecutor(input: {
  store: KnowledgeGraphStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge graph snapshot is unavailable");

    const stageRuns = await input.store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
    const extractManifestId = upstreamManifestId(run, stageRuns, "extract");
    const tablesManifestId = upstreamManifestId(run, stageRuns, "tables");
    const upstreamManifestIds = [extractManifestId, tablesManifestId];
    const inputDigest = knowledgeGraphPipelineInputDigest(snapshot, build.purpose, upstreamManifestIds);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge graph stage input digest does not match the persisted upstream manifests");
    }

    const [irManifest, tablesManifest] = await Promise.all([
      ownedManifest(input.store, run, extractManifestId, "extract", "knowledge-ir"),
      ownedManifest(input.store, run, tablesManifestId, "tables", "table-schemas")
    ]);
    const [ir, tables] = await Promise.all([
      input.artifactStore.getJson(irManifest).then((value) => knowledgeIrFromArtifact(irManifest, value)),
      input.artifactStore.getJson(tablesManifest).then((value) => tablesFromArtifact(tablesManifest, value))
    ]);
    const graph = buildKnowledgeGraph({
      projectId: run.projectId,
      ir: knowledgeIrSchema.parse({ ...ir, tables })
    });
    validateKnowledgeGraph(graph);

    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "graph",
        kind: "knowledge-graph",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: graph.nodes.flatMap((node) => node.sourceRefs),
        producer: "deterministic",
        createdAt: new Date().toISOString()
      },
      value: { schemaVersion: 1, snapshotId: snapshot.id, ...graph },
      actorId: input.actorId
    });
    if (!await input.store.getKnowledgeGraph(run.workspaceId, run.projectId, run.buildId)) {
      await input.store.saveKnowledgeGraph({
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        graph,
        actorId: input.actorId
      });
    }
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
