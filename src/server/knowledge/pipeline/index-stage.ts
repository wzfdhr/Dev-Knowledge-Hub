import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import type { ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineSearchDocumentInput,
  PipelineSearchDocumentStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const citationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  commitSha: z.string().min(1),
  blobHash: z.string().regex(/^[a-f0-9]{40,64}$/i)
});

const synthesisArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  output: z.object({
    pages: z.array(z.object({
      id: z.string().min(1),
      slug: z.string().min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      citations: z.array(citationSchema),
      chunks: z.array(z.object({
        id: z.string().min(1),
        heading: z.string().nullable(),
        content: z.string().min(1),
        citations: z.array(citationSchema)
      }))
    }))
  })
});

export interface PipelineSearchIndexStageStore extends PipelineArtifactStore, PipelineSearchDocumentStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function pipelineSearchIndexInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "index",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "index-v1:chunk-documents",
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
    || run.stage !== "index"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  ) {
    throw new Error("Pipeline search index stage does not match the project build and snapshot");
  }
}

async function synthesisManifestForRun(
  store: PipelineSearchIndexStageStore,
  run: PipelineStageRunRecord
): Promise<ArtifactManifest> {
  const synthesisRun = (await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId))
    .findLast((candidate) => candidate.stage === "synthesize"
      && (candidate.status === "succeeded" || candidate.status === "reused"));
  if (!synthesisRun || synthesisRun.outputManifestIds.length !== 1) {
    throw new Error("Pipeline search index stage requires exactly one completed knowledge pages artifact");
  }
  const manifest = await store.findArtifactById(synthesisRun.outputManifestIds[0]!);
  if (!manifest
    || manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.stage !== "synthesize"
    || manifest.kind !== "knowledge-pages"
  ) {
    throw new Error("Pipeline search index artifact does not match the project build and snapshot");
  }
  return manifest;
}

function documentsFromSynthesis(
  snapshotId: string,
  value: z.infer<typeof synthesisArtifactSchema>
): PipelineSearchDocumentInput[] {
  return value.output.pages.flatMap((page) => page.chunks.map((chunk, position) => ({
    documentKey: `${page.slug}:${position}`,
    kind: "page" as const,
    title: page.title,
    content: chunk.content,
    citations: chunk.citations.map((citation) => ({
      snapshotId,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      blobHash: citation.blobHash
    })),
    metadata: {
      pageId: page.id,
      pageSlug: page.slug,
      position,
      ...(chunk.heading ? { heading: chunk.heading } : {})
    }
  })));
}

export function createPipelineSearchIndexStageExecutor(input: {
  store: PipelineSearchIndexStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Pipeline search index snapshot is unavailable");

    const synthesisManifest = await synthesisManifestForRun(input.store, run);
    const inputDigest = pipelineSearchIndexInputDigest(snapshot, build.purpose, [synthesisManifest.id]);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Pipeline search index input digest does not match the persisted knowledge pages artifact");
    }
    const value = synthesisArtifactSchema.parse(await input.artifactStore.getJson(synthesisManifest));
    const documents = documentsFromSynthesis(snapshot.id, value);
    await input.store.savePipelineSearchDocuments({
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      snapshotId: run.snapshotId,
      buildId: run.buildId,
      sourceArtifactId: synthesisManifest.id,
      documents
    });
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "index",
        kind: "pipeline-search-index",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: documents.flatMap((document) => document.citations),
        producer: "deterministic",
        createdAt: new Date().toISOString()
      },
      value: {
        schemaVersion: 1,
        sourceArtifactId: synthesisManifest.id,
        documents
      },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
