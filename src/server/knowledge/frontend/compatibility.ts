import { z } from "zod";

import { frontendAnalyzerManifestDigest } from "../../../shared/frontend-ir.js";
import { frontendEdgeSchema, frontendEntitySchema } from "../../../shared/frontend-ir.js";
import type { ArtifactManifest, BuildStage } from "../pipeline/contracts.js";
import type {
  FrontendReleaseDraftProvenance,
  PipelineStageRunRecord,
  ReleaseRecord
} from "../../persistence/store.js";

export const RELEASE_ARTIFACT_FAMILIES = ["knowledge-v1", "frontend-v2"] as const;
export type ReleaseArtifactFamily = (typeof RELEASE_ARTIFACT_FAMILIES)[number];

export const FRONTEND_V2_IR_SCHEMA_VERSION = 2;
export const FRONTEND_V2_GRAPH_SCHEMA_VERSION = 2;
export const EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST = frontendAnalyzerManifestDigest([]);

export const ARTIFACT_KINDS: Record<BuildStage, Record<ReleaseArtifactFamily, { kind: string; schemaVersion: number }>> = {
  convert: {
    "knowledge-v1": { kind: "normalized-sources", schemaVersion: 1 },
    "frontend-v2": { kind: "normalized-sources", schemaVersion: 1 }
  },
  extract: {
    "knowledge-v1": { kind: "knowledge-ir", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-ir-v2", schemaVersion: 2 }
  },
  tables: {
    "knowledge-v1": { kind: "table-schemas", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-table-schemas-v2", schemaVersion: 2 }
  },
  graph: {
    "knowledge-v1": { kind: "knowledge-graph", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-graph-v2", schemaVersion: 2 }
  },
  synthesize: {
    "knowledge-v1": { kind: "knowledge-pages", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-knowledge-pages-v2", schemaVersion: 2 }
  },
  index: {
    "knowledge-v1": { kind: "pipeline-search-index", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-search-index-v2", schemaVersion: 2 }
  },
  lint: {
    "knowledge-v1": { kind: "knowledge-quality", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-knowledge-quality-v2", schemaVersion: 2 }
  },
  viz: {
    "knowledge-v1": { kind: "knowledge-visualization", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-visualization-v2", schemaVersion: 2 }
  },
  validate: {
    "knowledge-v1": { kind: "pipeline-validation", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-validation-v2", schemaVersion: 2 }
  },
  package: {
    "knowledge-v1": { kind: "pipeline-package", schemaVersion: 1 },
    "frontend-v2": { kind: "frontend-pipeline-package", schemaVersion: 2 }
  }
};

export const frontendPipelineEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  family: z.literal("frontend-v2"),
  stage: z.enum(["extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"]),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  upstreamManifestIds: z.array(z.string().min(1)),
  sourceArtifactId: z.string().min(1)
}).strict();

export const frontendGraphV2Schema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  nodes: z.array(frontendEntitySchema),
  edges: z.array(frontendEdgeSchema)
}).strict();

const frontendValidationEvidenceSchema = z.object({
  valid: z.literal(true),
  graphReferenceCount: z.number().int().positive(),
  checkedReferenceCount: z.number().int().positive(),
  invalidReferenceCount: z.literal(0)
}).passthrough().superRefine((value, context) => {
  if (value.checkedReferenceCount < value.graphReferenceCount) {
    context.addIssue({ code: "custom", message: "Checked references do not cover Graph references" });
  }
});

export const frontendValidationV2Schema = frontendPipelineEnvelopeSchema.extend({
  stage: z.literal("validate"),
  valid: z.boolean(),
  pageCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  graphReferenceCount: z.number().int().nonnegative(),
  checkedReferenceCount: z.number().int().nonnegative(),
  invalidReferenceCount: z.number().int().nonnegative()
}).strict();

export function assertFrontendCandidateValid(value: unknown): asserts value is {
  valid: true; graphReferenceCount: number; checkedReferenceCount: number; invalidReferenceCount: 0;
} {
  if (!value || typeof value !== "object" || !("valid" in value) || value.valid !== true) {
    throw new Error("Frontend shadow package requires a valid candidate");
  }
  if (!frontendValidationEvidenceSchema.safeParse(value).success) {
    throw new Error("Frontend shadow package requires complete Graph reference evidence");
  }
}

export const frontendPipelinePackageSchema = frontendPipelineEnvelopeSchema.extend({
  stage: z.literal("package"),
  irSchemaVersion: z.literal(FRONTEND_V2_IR_SCHEMA_VERSION),
  graphSchemaVersion: z.literal(FRONTEND_V2_GRAPH_SCHEMA_VERSION),
  artifacts: z.object({
    convert: z.array(z.string().min(1)).length(1),
    extract: z.array(z.string().min(1)).length(2),
    tables: z.array(z.string().min(1)).length(2),
    graph: z.array(z.string().min(1)).length(2),
    synthesize: z.array(z.string().min(1)).length(2),
    index: z.array(z.string().min(1)).length(2),
    lint: z.array(z.string().min(1)).length(2),
    viz: z.array(z.string().min(1)).length(2),
    validate: z.array(z.string().min(1)).length(2),
    package: z.array(z.string().min(1)).length(1)
  }).strict()
}).strict();

type FrontendReleaseStore = {
  getBuild(workspaceId: string, buildId: string): Promise<{
    id: string; workspaceId: string; repositoryId: string; snapshotId: string; status: string;
  } | null>;
  getRepository(workspaceId: string, repositoryId: string): Promise<{
    id: string; workspaceId: string; projectId: string;
  } | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
  createReleaseDraft(
    workspaceId: string,
    repositoryId: string,
    buildId: string,
    version: string,
    provenance?: FrontendReleaseDraftProvenance
  ): Promise<ReleaseRecord>;
};

export async function createVerifiedFrontendReleaseDraft(input: {
  store: FrontendReleaseStore;
  artifactReader: { getJson(manifest: ArtifactManifest): Promise<unknown> };
  workspaceId: string;
  repositoryId: string;
  buildId: string;
  version: string;
  packageStageRunId: string;
  packageArtifactId: string;
}): Promise<ReleaseRecord> {
  const [build, repository] = await Promise.all([
    input.store.getBuild(input.workspaceId, input.buildId),
    input.store.getRepository(input.workspaceId, input.repositoryId)
  ]);
  if (!build || !repository || build.status !== "ready"
    || build.workspaceId !== input.workspaceId || build.repositoryId !== repository.id) {
    throw new Error("Only a ready project build can create a frontend v2 release draft");
  }
  const runs = await input.store.listPipelineStageRuns(
    input.workspaceId, repository.projectId, input.buildId
  );
  const run = runs.find((candidate) => candidate.id === input.packageStageRunId);
  if (!run || run.stage !== "package" || !["succeeded", "reused"].includes(run.status)
    || run.snapshotId !== build.snapshotId || !run.outputManifestIds.includes(input.packageArtifactId)) {
    throw new Error("Frontend v2 package stage is not a terminal output of this build");
  }
  const manifest = await input.store.findArtifactById(input.packageArtifactId);
  if (!manifest || manifest.workspaceId !== input.workspaceId
    || manifest.projectId !== repository.projectId || manifest.snapshotId !== build.snapshotId
    || manifest.stage !== "package" || manifest.kind !== "frontend-pipeline-package"
    || manifest.schemaVersion !== 2) {
    throw new Error("Frontend v2 package artifact does not belong to this build scope");
  }
  const value = frontendPipelinePackageSchema.parse(await input.artifactReader.getJson(manifest));
  if (value.snapshotId !== build.snapshotId) {
    throw new Error("Frontend v2 package content does not match its release build");
  }
  if (!value.artifacts.package.includes(value.sourceArtifactId)
    || value.upstreamManifestIds.join("\0") !== value.artifacts.validate.join("\0")) {
    throw new Error("Frontend v2 package manifest is incomplete");
  }
  const artifactEntries = Object.entries(value.artifacts) as Array<[BuildStage, string[]]>;
  const artifactIds = artifactEntries.flatMap(([, ids]) => ids);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("Frontend v2 package manifest contains duplicate artifacts");
  }
  for (const [stage, ids] of artifactEntries) {
    const stageRun = runs.findLast((candidate) => candidate.stage === stage
      && ["succeeded", "reused"].includes(candidate.status)
      && candidate.snapshotId === build.snapshotId
      && ids.every((id) => candidate.outputManifestIds.includes(id)));
    if (!stageRun) throw new Error(`Frontend v2 package ${stage} artifacts are not completed build outputs`);
    const artifacts = await Promise.all(ids.map(async (id) => {
      const internal = await input.store.findArtifactById(id);
      if (!internal || internal.workspaceId !== input.workspaceId
        || internal.projectId !== repository.projectId || internal.snapshotId !== build.snapshotId
        || internal.stage !== stage) {
        throw new Error(`Frontend v2 package ${stage} artifact does not belong to this build scope`);
      }
      return { manifest: internal, value: await input.artifactReader.getJson(internal) };
    }));
    assertFrontendArtifactFamily(
      stage,
      stage === "package" ? ["knowledge-v1"] : ["knowledge-v1", "frontend-v2"],
      artifacts.map((artifact) => artifact.manifest)
    );
    if (stage === "validate") {
      const expected = ARTIFACT_KINDS.validate["frontend-v2"];
      const validation = artifacts.find((artifact) => artifact.manifest.kind === expected.kind
        && artifact.manifest.schemaVersion === expected.schemaVersion);
      const parsed = frontendValidationV2Schema.safeParse(validation?.value);
      if (!parsed.success) throw new Error("Frontend v2 release requires complete Graph reference evidence");
      try {
        assertFrontendCandidateValid(parsed.data);
      } catch (error) {
        throw new Error("Frontend v2 release requires complete Graph reference evidence", { cause: error });
      }
      if (parsed.data.snapshotId !== build.snapshotId
        || parsed.data.analyzerManifestDigest !== value.analyzerManifestDigest) {
        throw new Error("Frontend v2 validation provenance does not match its release package");
      }
    }
  }
  return input.store.createReleaseDraft(input.workspaceId, repository.id, build.id, input.version, {
    releaseArtifactFamily: "frontend-v2",
    packageArtifactId: manifest.id,
    packageStageRunId: run.id,
    artifactIds: [...artifactIds].sort(),
    frontendIrSchemaVersion: FRONTEND_V2_IR_SCHEMA_VERSION,
    frontendGraphSchemaVersion: FRONTEND_V2_GRAPH_SCHEMA_VERSION,
    analyzerManifestDigest: value.analyzerManifestDigest
  });
}

export function releaseArtifactFamily(value: { releaseArtifactFamily?: unknown }): ReleaseArtifactFamily {
  const family = value.releaseArtifactFamily ?? "knowledge-v1";
  if (family !== "knowledge-v1" && family !== "frontend-v2") {
    throw new Error(`Unsupported release artifact family: ${String(family)}`);
  }
  return family;
}

export function frontendStageArtifactKinds(stage: BuildStage, families: readonly ReleaseArtifactFamily[]): string[] {
  return [...new Set(families.map((family) => ARTIFACT_KINDS[stage][family].kind))].sort();
}

export function assertFrontendArtifactFamily(
  stage: BuildStage,
  families: readonly ReleaseArtifactFamily[],
  artifacts: ReadonlyArray<{ kind: string; schemaVersion: number }>
): void {
  for (const family of [...new Set(families)].sort()) {
    const expected = ARTIFACT_KINDS[stage][family];
    const matches = artifacts.filter((artifact) =>
      artifact.kind === expected.kind && artifact.schemaVersion === expected.schemaVersion
    );
    if (matches.length === 0) throw new Error(`Artifact family ${family} is missing ${expected.kind}@${expected.schemaVersion}`);
    if (matches.length !== 1) throw new Error(`Artifact family ${family} requires exactly one ${expected.kind}@${expected.schemaVersion}`);
  }
}
