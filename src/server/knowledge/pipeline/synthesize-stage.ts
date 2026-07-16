import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import { graphEdgeSchema, graphNodeSchema, type ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import { generateKnowledge, validateKnowledge } from "../generator.js";
import type { KnowledgeEnhancer } from "../enhancer.js";
import { analyzeSnapshot } from "../intelligence.js";
import { validateKnowledgeGraph } from "./graph.js";
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

export interface KnowledgeSynthesisStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
  sourceFileHashes(workspaceId: string, snapshotId: string): Promise<ReadonlyMap<string, string>>;
}

export function knowledgeSynthesisPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[],
  allowLlm = false
): string {
  return pipelineInputDigest({
    stage: "synthesize",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: `synthesize-v1:${allowLlm ? "manual-llm" : "deterministic"}`,
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
    || run.stage !== "synthesize"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  ) {
    throw new Error("Knowledge synthesis stage does not match the project build and snapshot");
  }
}

async function graphManifestForRun(
  store: KnowledgeSynthesisStageStore,
  run: PipelineStageRunRecord
): Promise<ArtifactManifest> {
  const graphRun = (await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId))
    .findLast((candidate) => candidate.stage === "graph"
      && (candidate.status === "succeeded" || candidate.status === "reused"));
  if (!graphRun || graphRun.outputManifestIds.length !== 1) {
    throw new Error("Knowledge synthesis stage requires exactly one completed graph artifact");
  }
  const manifest = await store.findArtifactById(graphRun.outputManifestIds[0]!);
  if (!manifest
    || manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.stage !== "graph"
    || manifest.kind !== "knowledge-graph"
  ) {
    throw new Error("Knowledge synthesis graph artifact does not match the project build and snapshot");
  }
  return manifest;
}

function artifactSourceRefs(snapshotId: string, output: Awaited<ReturnType<typeof generateKnowledge>>) {
  const seen = new Set<string>();
  return output.pages.flatMap((page) => page.citations).flatMap((citation) => {
    const key = `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.blobHash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      snapshotId,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      blobHash: citation.blobHash
    }];
  });
}

export function createKnowledgeSynthesisStageExecutor(input: {
  store: KnowledgeSynthesisStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
  enhancerForWorkspace?: (workspaceId: string) => Promise<KnowledgeEnhancer | undefined>;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge synthesis snapshot is unavailable");

    const graphManifest = await graphManifestForRun(input.store, run);
    const inputDigest = knowledgeSynthesisPipelineInputDigest(
      snapshot, build.purpose, [graphManifest.id], build.allowLlm === true
    );
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge synthesis input digest does not match the persisted graph artifact");
    }
    const graphArtifact = graphArtifactSchema.parse(await input.artifactStore.getJson(graphManifest));
    if (graphArtifact.snapshotId !== snapshot.id) {
      throw new Error("Knowledge synthesis graph artifact does not match the snapshot");
    }
    validateKnowledgeGraph({ nodes: graphArtifact.nodes, edges: graphArtifact.edges });

    const index = await analyzeSnapshot(
      snapshot.storagePath,
      snapshot.commitSha,
      await input.store.sourceFileHashes(run.workspaceId, snapshot.id)
    );
    const enhancer = build.allowLlm ? await input.enhancerForWorkspace?.(build.workspaceId) : undefined;
    const output = await generateKnowledge(index, enhancer, { purpose: build.purpose });
    validateKnowledge(output, index);
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "synthesize",
        kind: "knowledge-pages",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: artifactSourceRefs(snapshot.id, output),
        producer: enhancer ? "llm" : "deterministic",
        createdAt: new Date().toISOString()
      },
      value: { schemaVersion: 1, index, output },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
