import { z } from "zod";

import { sourceRefSchema, type ArtifactManifest } from "../../../shared/api-contracts.js";
import type { AppStore, PipelineStageRunRecord } from "../../persistence/store.js";
import { frontendGraphV2Schema, frontendPipelinePackageSchema } from "./compatibility.js";

const knowledgePagesSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  pages: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["architecture", "routes", "components", "data", "visualizations", "tooling-tests"]),
    items: z.array(z.object({
      entityId: z.string().min(1), kind: z.string().min(1), name: z.string().min(1),
      qualifiedName: z.string().min(1), sourceRefs: z.array(sourceRefSchema)
    })),
    citations: z.array(sourceRefSchema),
    chunks: z.array(z.object({ heading: z.string().min(1), content: z.string(), citations: z.array(sourceRefSchema) }))
  }))
});

const qualitySchema = z.object({
  schemaVersion: z.literal(2), snapshotId: z.string().min(1), analyzerManifestDigest: z.string().min(1),
  summary: z.object({
    entities: z.number().int().nonnegative(), factEdges: z.number().int().nonnegative(),
    candidateEdges: z.number().int().nonnegative(), citedEntities: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(), testedComponents: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(), visualizations: z.number().int().nonnegative()
  }),
  issues: z.array(z.object({
    rule: z.string().min(1), severity: z.enum(["warning", "info"]), targetId: z.string().min(1),
    message: z.string().min(1), sourceRefs: z.array(sourceRefSchema)
  }))
});

const searchSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: z.string().min(1),
  documents: z.array(z.object({
    documentKey: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    citations: z.array(sourceRefSchema),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  }))
});

const visualizationSchema = z.object({
  schemaVersion: z.literal(2), snapshotId: z.string().min(1), analyzerManifestDigest: z.string().min(1),
  routeIds: z.array(z.string()), componentIds: z.array(z.string()), visualizationIds: z.array(z.string()),
  factEdgeIds: z.array(z.string())
});

const validationSchema = z.object({
  schemaVersion: z.literal(2), family: z.literal("frontend-v2"), stage: z.literal("validate"),
  snapshotId: z.string().min(1), analyzerManifestDigest: z.string().min(1), valid: z.boolean(),
  pageCount: z.number().int().nonnegative(), issueCount: z.number().int().nonnegative(),
  graphReferenceCount: z.number().int().nonnegative(), checkedReferenceCount: z.number().int().nonnegative(),
  invalidReferenceCount: z.number().int().nonnegative()
}).passthrough().superRefine((value, context) => {
  if (value.valid && (value.graphReferenceCount === 0 || value.checkedReferenceCount < value.graphReferenceCount
    || value.invalidReferenceCount !== 0)) {
    context.addIssue({ code: "custom", message: "Valid frontend candidate lacks complete Graph reference evidence" });
  }
});

type PreviewStore = Pick<AppStore, "getBuild" | "getRepository" | "listPipelineStageRuns" | "findArtifactById">;
type PreviewReader = { getJson(manifest: ArtifactManifest): Promise<unknown> };

export class FrontendPreviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontendPreviewUnavailableError";
  }
}

function completedRun(runs: readonly PipelineStageRunRecord[], stage: PipelineStageRunRecord["stage"], artifactId: string) {
  return runs.findLast((run) => run.stage === stage && ["succeeded", "reused"].includes(run.status)
    && run.outputManifestIds.includes(artifactId));
}

async function artifact(input: {
  store: PreviewStore; runs: readonly PipelineStageRunRecord[]; ids: readonly string[];
  workspaceId: string; projectId: string; snapshotId: string; stage: PipelineStageRunRecord["stage"]; kind: string;
}): Promise<ArtifactManifest> {
  for (const id of input.ids) {
    const value = await input.store.findArtifactById(id);
    if (value?.kind !== input.kind) continue;
    if (value.workspaceId !== input.workspaceId || value.projectId !== input.projectId
      || value.snapshotId !== input.snapshotId || value.stage !== input.stage
      || !completedRun(input.runs, input.stage, value.id)) {
      throw new FrontendPreviewUnavailableError(`Frontend ${input.stage} artifact crosses the candidate package scope`);
    }
    return value;
  }
  throw new FrontendPreviewUnavailableError(`Frontend ${input.stage} artifact is unavailable`);
}

export async function loadFrontendCandidatePreview(input: {
  store: PreviewStore; reader: PreviewReader; workspaceId: string; projectId: string; buildId: string;
}) {
  const build = await input.store.getBuild(input.workspaceId, input.buildId);
  const repository = build ? await input.store.getRepository(input.workspaceId, build.repositoryId) : null;
  if (!build || !repository || repository.projectId !== input.projectId) {
    throw new FrontendPreviewUnavailableError("Frontend preview build does not belong to this project");
  }
  const runs = await input.store.listPipelineStageRuns(input.workspaceId, input.projectId, input.buildId);
  const packageRun = runs.findLast((run) => run.stage === "package" && ["succeeded", "reused"].includes(run.status));
  if (!packageRun) throw new FrontendPreviewUnavailableError("Frontend candidate package is not complete");
  const packageManifest = await artifact({
    store: input.store, runs, ids: packageRun.outputManifestIds, workspaceId: input.workspaceId,
    projectId: input.projectId, snapshotId: build.snapshotId, stage: "package", kind: "frontend-pipeline-package"
  });
  const packageValue = frontendPipelinePackageSchema.parse(await input.reader.getJson(packageManifest));
  if (packageValue.snapshotId !== build.snapshotId) {
    throw new FrontendPreviewUnavailableError("Frontend candidate package snapshot does not match the build");
  }
  const load = async (stage: "graph" | "synthesize" | "index" | "lint" | "viz" | "validate", kind: string) => {
    const value = await artifact({
      store: input.store, runs, ids: packageValue.artifacts[stage], workspaceId: input.workspaceId,
      projectId: input.projectId, snapshotId: build.snapshotId, stage, kind
    });
    return input.reader.getJson(value);
  };
  const [graph, pages, search, quality, visualization, validation] = await Promise.all([
    load("graph", "frontend-graph-v2").then((value) => frontendGraphV2Schema.parse(value)),
    load("synthesize", "frontend-knowledge-pages-v2").then((value) => knowledgePagesSchema.parse(value)),
    load("index", "frontend-search-index-v2").then((value) => searchSchema.parse(value)),
    load("lint", "frontend-knowledge-quality-v2").then((value) => qualitySchema.parse(value)),
    load("viz", "frontend-visualization-v2").then((value) => visualizationSchema.parse(value)),
    load("validate", "frontend-validation-v2").then((value) => validationSchema.parse(value))
  ]);
  if (!validation.valid) throw new FrontendPreviewUnavailableError("Frontend candidate validation failed");
  return {
    build: { id: build.id, snapshotId: build.snapshotId, commitSha: build.commitSha, status: build.status },
    graph, pages: pages.pages, search: search.documents, quality, visualization, validation
  };
}

export type FrontendCandidatePreview = Awaited<ReturnType<typeof loadFrontendCandidatePreview>>;
