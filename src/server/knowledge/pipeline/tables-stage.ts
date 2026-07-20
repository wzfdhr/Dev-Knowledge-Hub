import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ArtifactManifest, TableSchema } from "./contracts.js";
import { type ArtifactStore } from "./artifact-store.js";
import { convertSnapshotTableFile, type SnapshotTableFile } from "./convert.js";
import { pipelineInputDigest } from "./input-digest.js";
import {
  normalizedSourceReferencesSchema,
  type SourceBlobReader
} from "./source-blob-reader.js";
import { extractCsvTable, extractXlsxTables, type TableExtractionResult } from "./tables.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const tableExtensions = new Set([".csv", ".xlsx"]);

export interface TableSchemasStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<SourceFileRecord[]>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
}

export function tableSchemasPipelineInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "tables",
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

function ownsTableSchemasStage(
  run: PipelineStageRunRecord,
  build: BuildRecord,
  repository: RepositoryRecord,
  snapshot: SourceSnapshotRecord
): boolean {
  return !(
    run.stage !== "tables"
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
  if (!build || !repository || !snapshot || !ownsTableSchemasStage(run, build, repository, snapshot)) {
    throw new Error("Table schemas stage does not match the project build and snapshot");
  }
}

function assertOwnedUpstreamManifest(run: PipelineStageRunRecord, manifest: ArtifactManifest): void {
  if (
    manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.stage !== "convert"
    || !(
      (manifest.kind === "normalized-sources" && manifest.schemaVersion === 1)
      || (manifest.kind === "normalized-source-refs" && manifest.schemaVersion === 2)
    )
  ) {
    throw new Error("Table schemas upstream manifest does not match the project build and snapshot");
  }
}

function convertOutputManifestIds(stageRuns: readonly PipelineStageRunRecord[]): string[] {
  const convertRuns = stageRuns.filter((candidate) => candidate.stage === "convert");
  if (convertRuns.length === 0) throw new Error("Table schemas stage requires a convert run");
  const convertRun = convertRuns.findLast((candidate) => candidate.status === "succeeded" || candidate.status === "reused");
  if (!convertRun) throw new Error("Table schemas stage requires a succeeded or reused convert run");
  if (convertRun.outputManifestIds.length === 0) throw new Error("Table schemas stage requires at least one upstream manifest");
  if (new Set(convertRun.outputManifestIds).size !== convertRun.outputManifestIds.length) {
    throw new Error("Table schemas stage requires unique upstream manifests");
  }
  if (convertRun.outputManifestIds.length !== 1) {
    throw new Error("Table schemas stage requires exactly one convert artifact family");
  }
  return convertRun.outputManifestIds;
}

function isTableSourceFile(file: Pick<SourceFileRecord, "path">): boolean {
  return tableExtensions.has(path.posix.extname(file.path).toLowerCase());
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedTables(results: readonly TableExtractionResult[]): TableExtractionResult[] {
  return [...results].sort((left, right) =>
    compareUtf8(left.table.sourcePath, right.table.sourcePath)
    || compareUtf8(left.table.sheet ?? "", right.table.sheet ?? "")
    || compareUtf8(left.table.id, right.table.id)
  );
}

async function extractTableSource(source: SnapshotTableFile): Promise<TableExtractionResult[]> {
  if (path.posix.extname(source.path).toLowerCase() === ".csv") {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(source.content);
    } catch {
      throw new Error("Table CSV source is not valid UTF-8");
    }
    return [extractCsvTable({ ...source, content })];
  }
  return extractXlsxTables(source);
}

async function extractTableFile(
  snapshot: SourceSnapshotRecord,
  file: SourceFileRecord
): Promise<TableExtractionResult[]> {
  return extractTableSource(await convertSnapshotTableFile({ snapshot, file }));
}

export function createTableSchemasStageExecutor(input: {
  store: TableSchemasStageStore;
  artifactStore: ArtifactStore;
  actorId?: string;
  sourceBlobReader?: SourceBlobReader;
}): PipelineStageExecutor {
  return async (run) => {
    const build = await input.store.getBuild(run.workspaceId, run.buildId);
    const repository = build ? await input.store.getRepository(run.workspaceId, build.repositoryId) : null;
    const snapshot = await input.store.findSnapshotById(run.workspaceId, run.snapshotId);
    assertOwnedBuild(run, build, repository, snapshot);
    if (!snapshot) throw new Error("Table schemas snapshot is unavailable");

    const upstreamManifestIds = convertOutputManifestIds(await input.store.listPipelineStageRuns(
      run.workspaceId, run.projectId, run.buildId
    ));
    const inputDigest = tableSchemasPipelineInputDigest(snapshot, build.purpose, upstreamManifestIds);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Table schemas stage input digest does not match the persisted upstream manifests");
    }
    const manifests = await Promise.all(upstreamManifestIds.map(async (artifactId) => {
      const manifest = await input.store.findArtifactById(artifactId);
      if (!manifest) throw new Error("Table schemas upstream manifest is unavailable");
      assertOwnedUpstreamManifest(run, manifest);
      return manifest;
    }));
    const manifest = manifests[0]!;
    let extractedResults: TableExtractionResult[][];
    if (manifest.kind === "normalized-source-refs") {
      if (!input.sourceBlobReader) throw new Error("Table schemas source blob reader is unavailable");
      const normalized = normalizedSourceReferencesSchema.parse(await input.artifactStore.getJson(manifest));
      if (normalized.snapshotId !== manifest.snapshotId) {
        throw new Error("Normalized source references artifact does not match its snapshot");
      }
      extractedResults = await Promise.all(normalized.sources.filter(isTableSourceFile)
        .sort((left, right) => compareUtf8(left.path, right.path)).map(async (source) => {
          const sourceRef = manifest.sourceRefs.find((reference) =>
            reference.snapshotId === source.snapshotId
            && reference.path === source.path
            && reference.blobHash === source.blobHash
          );
          if (source.snapshotId !== manifest.snapshotId || !sourceRef) {
            throw new Error("Normalized source references artifact contains an invalid table source");
          }
          return extractTableSource({
            snapshotId: source.snapshotId,
            path: source.path,
            content: await input.sourceBlobReader!.read(run.workspaceId, source),
            blobHash: source.blobHash
          });
        }));
    } else {
      const files = (await input.store.listSnapshotFiles(run.workspaceId, run.snapshotId))
        .filter(isTableSourceFile)
        .sort((left, right) => compareUtf8(left.path, right.path));
      extractedResults = await Promise.all(files.map((file) => extractTableFile(snapshot, file)));
    }
    const extracted = sortedTables(extractedResults.flat());
    const tables: TableSchema[] = extracted.map((result) => result.table);
    const artifact = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        snapshotId: run.snapshotId,
        buildId: run.buildId,
        stage: "tables",
        kind: "table-schemas",
        schemaVersion: 1,
        inputDigest,
        contentDigest: "0".repeat(64),
        storageKey: "pending",
        sourceRefs: tables.flatMap((table) => table.sourceRefs),
        producer: "deterministic",
        createdAt: new Date().toISOString()
      },
      value: {
        schemaVersion: 1,
        snapshotId: snapshot.id,
        tables,
        samples: extracted.map((result) => ({ tableId: result.table.id, rows: result.sample }))
      },
      actorId: input.actorId
    });
    return { outputManifestIds: [artifact.manifest.id], reused: artifact.reused };
  };
}
