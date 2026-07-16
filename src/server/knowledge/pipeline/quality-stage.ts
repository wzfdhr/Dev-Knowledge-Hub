import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { LintIssue } from "../../../shared/api-contracts.js";
import { type ArtifactStore } from "./artifact-store.js";
import { knowledgeIrSchema, lintIssueSchema, tableSchemaSchema, type ArtifactManifest } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";
import type { PipelineStageExecutor } from "./worker.js";
import type { BuildRecord } from "../build-service.js";
import { assessKnowledgeQuality } from "../quality-assessment.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  RemediationRecord,
  RepositoryRecord,
  SourceSnapshotRecord
} from "../../persistence/store.js";

const extractionArtifactSchema = knowledgeIrSchema.extend({ lintIssues: z.array(lintIssueSchema).default([]) });
const tablesArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  tables: z.array(tableSchemaSchema)
});
const synthesisArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  output: z.object({ pages: z.array(z.unknown()) })
});

type QualityUpstreamStage = "extract" | "tables" | "synthesize" | "index";

export interface KnowledgeQualityStageStore extends PipelineArtifactStore {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
  createRemediation(input: {
    workspaceId: string;
    projectId: string;
    repositoryId: string;
    sourceBuildId: string;
    issue: LintIssue;
  }): Promise<RemediationRecord>;
}

export function pipelineKnowledgeQualityInputDigest(
  snapshot: Pick<SourceSnapshotRecord, "id">,
  purpose: BuildRecord["purpose"],
  upstreamManifestIds: readonly string[]
): string {
  return pipelineInputDigest({
    stage: "lint",
    snapshotId: snapshot.id,
    upstreamManifestIds,
    parserConfigVersion: "quality-v2:artifact-inputs",
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
    || run.stage !== "lint"
    || build.workspaceId !== run.workspaceId
    || build.id !== run.buildId
    || build.repositoryId !== repository.id
    || build.snapshotId !== snapshot.id
    || repository.workspaceId !== run.workspaceId
    || repository.projectId !== run.projectId
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.repositoryId !== build.repositoryId
  ) {
    throw new Error("Knowledge quality stage does not match the project build and snapshot");
  }
}

function ownedManifest(
  run: PipelineStageRunRecord,
  manifest: ArtifactManifest,
  stage: QualityUpstreamStage,
  kind: string
): void {
  if (manifest.workspaceId !== run.workspaceId
    || manifest.projectId !== run.projectId
    || manifest.snapshotId !== run.snapshotId
    || manifest.buildId !== run.buildId
    || manifest.stage !== stage
    || manifest.kind !== kind
  ) {
    throw new Error(`Knowledge quality ${stage} artifact does not match the project build and snapshot`);
  }
}

async function upstreamManifests(
  store: KnowledgeQualityStageStore,
  run: PipelineStageRunRecord
): Promise<Record<QualityUpstreamStage, ArtifactManifest>> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const requirements: Array<[QualityUpstreamStage, string]> = [
    ["extract", "knowledge-ir"],
    ["tables", "table-schemas"],
    ["synthesize", "knowledge-pages"],
    ["index", "pipeline-search-index"]
  ];
  const resolved = await Promise.all(requirements.map(async ([stage, kind]) => {
    const stageRun = runs.findLast((candidate) => candidate.stage === stage
      && (candidate.status === "succeeded" || candidate.status === "reused"));
    if (!stageRun || stageRun.outputManifestIds.length !== 1) {
      throw new Error(`Knowledge quality stage requires exactly one completed ${stage} artifact`);
    }
    const manifest = await store.findArtifactById(stageRun.outputManifestIds[0]!);
    if (!manifest) throw new Error(`Knowledge quality ${stage} artifact is unavailable`);
    ownedManifest(run, manifest, stage, kind);
    return [stage, manifest] as const;
  }));
  return Object.fromEntries(resolved) as Record<QualityUpstreamStage, ArtifactManifest>;
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
    if (!snapshot) throw new Error("Knowledge quality snapshot is unavailable");

    const upstream = await upstreamManifests(input.store, run);
    const upstreamManifestIds = [upstream.extract.id, upstream.tables.id, upstream.synthesize.id, upstream.index.id];
    const inputDigest = pipelineKnowledgeQualityInputDigest(snapshot, build.purpose, upstreamManifestIds);
    if (run.inputDigest !== inputDigest) {
      throw new Error("Knowledge quality input digest does not match the persisted pipeline artifacts");
    }
    const [extracted, tables, synthesized] = await Promise.all([
      input.artifactStore.getJson(upstream.extract).then((value) => extractionArtifactSchema.parse(value)),
      input.artifactStore.getJson(upstream.tables).then((value) => tablesArtifactSchema.parse(value)),
      input.artifactStore.getJson(upstream.synthesize).then((value) => synthesisArtifactSchema.parse(value))
    ]);
    if (extracted.snapshotId !== snapshot.id || tables.snapshotId !== snapshot.id) {
      throw new Error("Knowledge quality artifacts do not match the snapshot");
    }
    const quality = assessKnowledgeQuality({
      buildId: build.id,
      projectId: run.projectId,
      ir: { ...extracted, tables: tables.tables },
      knowledgePageCount: synthesized.output.pages.length,
      extractionIssues: extracted.lintIssues
    });
    const artifact = await input.artifactStore.putJson({
      manifest: {
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
      },
      value: { schemaVersion: 1, upstreamManifestIds, ...quality },
      actorId: input.actorId
    });
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
