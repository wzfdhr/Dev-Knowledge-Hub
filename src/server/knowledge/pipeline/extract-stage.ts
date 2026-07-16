import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { type ArtifactStore } from "./artifact-store.js";
import { knowledgeIrSchema, type ArtifactManifest, type KnowledgeIR } from "./contracts.js";
import { extractDocumentSource } from "./extract-documents.js";
import { extractVueSfc } from "./extract-vue.js";
import { extractWebSource } from "./extract-web.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const documentExtensions = new Set([".md", ".json", ".yaml", ".yml"]);

const normalizedSourceSchema = z.object({
  snapshotId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
});

const normalizedSourcesSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  sources: z.array(normalizedSourceSchema)
});

type NormalizedSource = z.infer<typeof normalizedSourceSchema>;

export interface KnowledgeIrStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function knowledgeIrPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "extract",
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

function ownsKnowledgeIrStage(
  run: PipelineStageRunRecord,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "extract"
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
  if (!build || !repository || !snapshot || !ownsKnowledgeIrStage(run, build, repository, snapshot)) {
    throw new Error("Knowledge IR stage does not match the project build and snapshot");
  }
}

function assertOwnedUpstreamManifest(run: PipelineStageRunRecord, manifest: ArtifactManifest): void {
  if (
    manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.buildId !== run.buildId
    || manifest.stage !== "convert"
    || manifest.kind !== "normalized-sources"
  ) {
    throw new Error("Knowledge IR upstream manifest does not match the project build and snapshot");
  }
}

function convertOutputManifestIds(stageRuns: readonly PipelineStageRunRecord[]): string[] {
  const convertRuns = stageRuns.filter((candidate) => candidate.stage === "convert");
  if (convertRuns.length === 0) {
    throw new Error("Knowledge IR stage requires a convert run");
  }
  const convertRun = convertRuns.findLast((candidate) => candidate.status === "succeeded" || candidate.status === "reused");
  if (!convertRun) {
    throw new Error("Knowledge IR stage requires a succeeded or reused convert run");
  }
  if (convertRun.outputManifestIds.length === 0) {
    throw new Error("Knowledge IR stage requires at least one upstream manifest");
  }
  if (new Set(convertRun.outputManifestIds).size !== convertRun.outputManifestIds.length) {
    throw new Error("Knowledge IR stage requires unique upstream manifests");
  }
  return convertRun.outputManifestIds;
}

function sourceDigest(source: NormalizedSource): string {
  return createHash("sha256").update(source.content, "utf8").digest("hex");
}

function assertNormalizedSources(manifest: ArtifactManifest, value: unknown): NormalizedSource[] {
  const normalized = normalizedSourcesSchema.parse(value);
  if (normalized.snapshotId !== manifest.snapshotId) {
    throw new Error("Normalized sources artifact does not match its snapshot");
  }
  for (const source of normalized.sources) {
    const sourceRef = manifest.sourceRefs.find((reference) =>
      reference.snapshotId === source.snapshotId && reference.path === source.path && reference.blobHash === source.blobHash
    );
    if (source.snapshotId !== manifest.snapshotId || !sourceRef || sourceDigest(source) !== source.blobHash) {
      throw new Error("Normalized sources artifact contains an invalid source");
    }
  }
  return normalized.sources;
}

function extractSource(source: NormalizedSource) {
  const extension = path.posix.extname(source.path).toLowerCase();
  if (extension === ".vue") return extractVueSfc(source);
  if (documentExtensions.has(extension)) return extractDocumentSource(source);
  if (codeExtensions.has(extension)) return extractWebSource(source);
  throw new Error(`Normalized sources artifact contains unsupported source: ${source.path}`);
}

function combineKnowledgeIr(snapshotId: string, sources: readonly NormalizedSource[]): KnowledgeIR {
  const extracted = sources
    .slice()
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
    .map(extractSource);
  return knowledgeIrSchema.parse({
    schemaVersion: 1,
    snapshotId,
    files: extracted.flatMap((result) => result.ir.files),
    symbols: extracted.flatMap((result) => result.ir.symbols),
    imports: extracted.flatMap((result) => result.ir.imports),
    documents: extracted.flatMap((result) => result.ir.documents),
    tables: [],
    sourceRefs: extracted.flatMap((result) => result.ir.sourceRefs)
  });
}

export function createKnowledgeIrStageExecutor(input: {
  store: KnowledgeIrStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Knowledge IR snapshot is unavailable");
    const upstreamManifestIds = convertOutputManifestIds(await input.store.listPipelineStageRuns(
      run.workspaceId, run.projectId, run.buildId
    ));
    const inputDigest = knowledgeIrPipelineInputDigest(snapshot, build.purpose, upstreamManifestIds);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge IR stage input digest does not match the persisted upstream manifests");
    }

    const manifests = await Promise.all(upstreamManifestIds.map(async (artifactId) => {
      const manifest = await input.store.findArtifactById(artifactId);
      if (!manifest) throw new Error("Knowledge IR stage upstream manifest is unavailable");
      assertOwnedUpstreamManifest(run, manifest);
      return manifest;
    }));
    const sources = (await Promise.all(manifests.map(async (manifest) =>
      assertNormalizedSources(manifest, await input.artifactStore.getJson(manifest))
    ))).flat();
    const ir = combineKnowledgeIr(snapshot.id, sources);
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "extract",
        kind: "knowledge-ir",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: ir.sourceRefs,
        producer: "deterministic",
        createdAt: new Date().toISOString()
      },
      value: ir,
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
