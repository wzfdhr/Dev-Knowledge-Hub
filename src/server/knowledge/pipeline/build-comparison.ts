import { z } from "zod";

import { trustScoreSchema, type ArtifactManifest, type GraphNode, type SourceRef } from "../../../shared/api-contracts.js";
import type { AppStore, KnowledgeMetadata, PipelineStageRunRecord } from "../../persistence/store.js";
import {
  compareKnowledgeKernelOutputs,
  type ComparableCitation,
  type ComparableKnowledgeOutput,
  type KnowledgeKernelComparison
} from "./comparison.js";

const citationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
});
const synthesisArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  output: z.object({
    pages: z.array(z.object({
      slug: z.string().min(1),
      citations: z.array(citationSchema),
      chunks: z.array(z.object({ citations: z.array(citationSchema) }))
    }))
  })
});
const qualityArtifactSchema = z.object({ trust: trustScoreSchema, issues: z.array(z.unknown()) });

type ComparisonStore = Pick<AppStore,
  "getBuild" | "getRepository" | "listKnowledgePagesForBuild" | "knowledgeMetadataForBuild"
  | "getKnowledgeGraph" | "listPipelineSearchDocuments" | "listPipelineStageRuns" | "findArtifactById"
>;

export interface PipelineArtifactReader {
  getJson(manifest: ArtifactManifest): Promise<unknown>;
}

export class PipelineComparisonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineComparisonUnavailableError";
  }
}

function sourceCitation(reference: SourceRef, commitSha: string): ComparableCitation {
  return {
    path: reference.path, startLine: reference.startLine, endLine: reference.endLine,
    commitSha, blobHash: reference.blobHash
  };
}

function legacyGraph(metadata: KnowledgeMetadata): ComparableKnowledgeOutput["graph"] {
  const paths = new Set(metadata.symbols.map((symbol) => symbol.path));
  const nodes = [
    ...[...paths].map((path) => `module:${path}`),
    ...metadata.symbols.map((symbol) => `symbol:${symbol.path}:${symbol.name}`)
  ];
  const edges = [
    ...metadata.symbols.map((symbol) => `contains:module:${symbol.path}->symbol:${symbol.path}:${symbol.name}`),
    ...metadata.dependencies.flatMap((dependency) => dependency.targetPath
      ? [`imports:module:${dependency.path}->module:${dependency.targetPath}`]
      : [])
  ];
  return { nodes, edges };
}

function nodeKey(node: GraphNode): string {
  if (node.kind === "module") return `module:${node.qualifiedName}`;
  if (node.kind === "symbol") return `symbol:${node.sourceRefs[0]?.path ?? ""}:${node.name}`;
  return `${node.kind}:${node.qualifiedName}`;
}

function pipelineGraph(graph: Awaited<ReturnType<ComparisonStore["getKnowledgeGraph"]>>): ComparableKnowledgeOutput["graph"] {
  if (!graph) throw new PipelineComparisonUnavailableError("Pipeline graph is unavailable");
  const nodes = new Map(graph.nodes.map((node) => [node.id, nodeKey(node)]));
  return {
    nodes: [...nodes.values()],
    edges: graph.edges.flatMap((edge) => {
      if (edge.candidate) return [];
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      return from && to ? [`${edge.kind}:${from}->${to}`] : [];
    })
  };
}

function completedRun(
  runs: readonly PipelineStageRunRecord[],
  stage: "synthesize" | "lint"
): PipelineStageRunRecord {
  const run = runs.findLast((candidate) => candidate.stage === stage
    && (candidate.status === "succeeded" || candidate.status === "reused"));
  if (!run || run.outputManifestIds.length !== 1) {
    throw new PipelineComparisonUnavailableError(`Pipeline ${stage} output is unavailable`);
  }
  return run;
}

async function ownedArtifact(input: {
  store: ComparisonStore;
  id: string;
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  stage: "synthesize" | "lint";
  kind: "knowledge-pages" | "knowledge-quality";
}): Promise<ArtifactManifest> {
  const manifest = await input.store.findArtifactById(input.id);
  if (!manifest || manifest.workspaceId !== input.workspaceId || manifest.projectId !== input.projectId
    || manifest.snapshotId !== input.snapshotId || manifest.stage !== input.stage || manifest.kind !== input.kind) {
    throw new PipelineComparisonUnavailableError(`Pipeline ${input.stage} artifact does not match this build`);
  }
  return manifest;
}

export async function buildKnowledgeKernelComparison(input: {
  store: ComparisonStore;
  reader: PipelineArtifactReader;
  workspaceId: string;
  projectId: string;
  buildId: string;
}): Promise<{ buildId: string; comparison: KnowledgeKernelComparison }> {
  const build = await input.store.getBuild(input.workspaceId, input.buildId);
  const repository = build ? await input.store.getRepository(input.workspaceId, build.repositoryId) : null;
  if (!build || !repository || repository.projectId !== input.projectId || build.snapshotId.length === 0) {
    throw new PipelineComparisonUnavailableError("Build does not belong to this project");
  }
  const [pages, metadata, graph, documents, runs] = await Promise.all([
    input.store.listKnowledgePagesForBuild(input.workspaceId, build.id),
    input.store.knowledgeMetadataForBuild(input.workspaceId, build.id),
    input.store.getKnowledgeGraph(input.workspaceId, input.projectId, build.id),
    input.store.listPipelineSearchDocuments(input.workspaceId, input.projectId, build.id),
    input.store.listPipelineStageRuns(input.workspaceId, input.projectId, build.id)
  ]);
  const synthesisRun = completedRun(runs, "synthesize");
  const qualityRun = completedRun(runs, "lint");
  const [synthesisManifest, qualityManifest] = await Promise.all([
    ownedArtifact({ store: input.store, id: synthesisRun.outputManifestIds[0]!, workspaceId: input.workspaceId,
      projectId: input.projectId, snapshotId: build.snapshotId, stage: "synthesize", kind: "knowledge-pages" }),
    ownedArtifact({ store: input.store, id: qualityRun.outputManifestIds[0]!, workspaceId: input.workspaceId,
      projectId: input.projectId, snapshotId: build.snapshotId, stage: "lint", kind: "knowledge-quality" })
  ]);
  const [synthesis, quality] = await Promise.all([
    input.reader.getJson(synthesisManifest).then((value) => synthesisArtifactSchema.parse(value)),
    input.reader.getJson(qualityManifest).then((value) => qualityArtifactSchema.parse(value))
  ]);
  const legacy: ComparableKnowledgeOutput = {
    pages: pages.map((page) => ({ key: page.slug, citations: page.chunks.flatMap((chunk) => chunk.citations) })),
    graph: legacyGraph(metadata),
    search: pages.flatMap((page) => page.chunks.map((chunk, position) => ({
      key: `${page.slug}:${position}`, citations: chunk.citations
    }))),
    quality: { issueCount: 0, trust: null }
  };
  const pipeline: ComparableKnowledgeOutput = {
    pages: synthesis.output.pages.map((page) => ({
      key: page.slug, citations: [...page.citations, ...page.chunks.flatMap((chunk) => chunk.citations)]
    })),
    graph: pipelineGraph(graph),
    search: documents.map((document) => ({
      key: document.documentKey,
      citations: document.citations.map((reference) => sourceCitation(reference, build.commitSha))
    })),
    quality: { issueCount: quality.issues.length, trust: quality.trust.score }
  };
  return { buildId: build.id, comparison: compareKnowledgeKernelOutputs({ legacy, pipeline }) };
}
