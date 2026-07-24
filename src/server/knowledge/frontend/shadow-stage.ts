import { randomUUID } from "node:crypto";

import { z } from "zod";

import { frontendIrSchema, type FrontendIR } from "../../../shared/frontend-ir.js";

import type { BuildRecord } from "../build-service.js";
import { type ArtifactStore } from "../pipeline/artifact-store.js";
import { BUILD_STAGES, type ArtifactManifest, type BuildStage } from "../pipeline/contracts.js";
import { knowledgeIrPipelineInputDigest } from "../pipeline/extract-stage.js";
import { knowledgeGraphPipelineInputDigest } from "../pipeline/graph-stage.js";
import { pipelineSearchIndexInputDigest } from "../pipeline/index-stage.js";
import { pipelineInputDigest } from "../pipeline/input-digest.js";
import {
  normalizedSourceReferencesSchema,
  type SourceBlobReader
} from "../pipeline/source-blob-reader.js";
import { knowledgePackagePipelineInputDigest } from "../pipeline/package-stage.js";
import { pipelineKnowledgeQualityInputDigest } from "../pipeline/quality-stage.js";
import { knowledgeSynthesisPipelineInputDigest } from "../pipeline/synthesize-stage.js";
import { tableSchemasPipelineInputDigest } from "../pipeline/tables-stage.js";
import { knowledgeValidationPipelineInputDigest } from "../pipeline/validate-stage.js";
import { knowledgeVisualizationPipelineInputDigest } from "../pipeline/viz-stage.js";
import { createB02StageInputPlanner } from "../pipeline/stage-planner.js";
import type { PipelineStageExecutor, PipelineStageInputPlanner } from "../pipeline/worker.js";
import type {
  PipelineArtifactStore,
  PipelineStageRunRecord,
  SourceAnalysisArtifactStore,
  SourceSnapshotRecord
} from "../../persistence/store.js";
import {
  ARTIFACT_KINDS,
  EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
  FRONTEND_V2_GRAPH_SCHEMA_VERSION,
  FRONTEND_V2_IR_SCHEMA_VERSION,
  assertFrontendCandidateValid,
  assertFrontendArtifactFamily,
  assertFrontendValidationProvenance,
  frontendStageArtifactKinds,
  frontendGraphV2Schema,
  frontendValidationV2Schema,
  type SourceStorageMode
} from "./compatibility.js";
import type { FrontendKnowledgeMode } from "./rollout-mode.js";
import type { ParserAnalyzeRequest } from "./runtime/parser-protocol.js";
import { SourceAnalysisCache } from "./source-analysis-cache.js";
import { typeScriptSyntaxParserConfigDigest } from "./typescript-program.js";
import { buildFrontendGraph } from "./graph-builder.js";
import { generateFrontendKnowledge } from "./knowledge-generator.js";
import { assessFrontendKnowledgeQuality } from "./quality-assessment.js";
import { frontendSourceReferenceIsValid, loadFrontendSourceDescriptors } from "./reference-validation.js";
import { buildFrontendSearchDocuments } from "./search.js";

const SHADOW_FAMILIES = ["knowledge-v1", "frontend-v2"] as const;
const UPSTREAM_STAGES: Record<Exclude<BuildStage, "convert">, readonly BuildStage[]> = {
  extract: ["convert"],
  tables: ["convert"],
  graph: ["extract", "tables"],
  synthesize: ["graph"],
  index: ["synthesize"],
  lint: ["extract", "tables", "synthesize", "index"],
  viz: ["graph"],
  validate: ["graph", "synthesize", "index", "lint", "viz"],
  package: ["validate"]
};

type ShadowStore = PipelineArtifactStore & SourceAnalysisArtifactStore & {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<Array<{ path: string; contentHash: string }>>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
};

export interface FrontendParserClient {
  analyze(input: Omit<ParserAnalyzeRequest, "type" | "requestId">, signal?: AbortSignal): Promise<unknown>;
}

const parserNormalizedSourcesSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  sources: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
    blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
  }))
});

const parserRuntimeResultSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  outputs: z.array(z.object({
    analyzerId: z.literal("typescript-project"),
    analyzerVersion: z.literal("1.0.0"),
    projectManifest: z.json(),
    projectReferences: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
    resolutions: z.array(z.object({
      containingFile: z.string().min(1),
      specifier: z.string().min(1),
      resolvedPath: z.string().min(1).nullable()
    }).strict()),
    files: z.array(z.object({
      path: z.string().min(1),
      blobHash: z.string().regex(/^[a-f0-9]{64}$/i),
      parserConfigDigest: z.string().regex(/^[a-f0-9]{64}$/i),
      facts: z.record(z.string(), z.json())
    }).strict()),
    frontendIr: frontendIrSchema
  }).strict()).max(1)
});

const typedSourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function isTypedSource(sourcePath: string): boolean {
  return sourcePath.endsWith(".d.ts") || typedSourceExtensions.has(sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase());
}

function completedRun(runs: readonly PipelineStageRunRecord[], stage: BuildStage): PipelineStageRunRecord {
  const run = runs.findLast((candidate) => candidate.stage === stage
    && (candidate.status === "succeeded" || candidate.status === "reused"));
  if (!run) throw new Error(`Frontend shadow stage requires a completed ${stage} run`);
  return run;
}

async function manifestsForRun(store: ShadowStore, run: PipelineStageRunRecord): Promise<ArtifactManifest[]> {
  const manifests = await Promise.all(run.outputManifestIds.map((id) => store.findArtifactById(id)));
  if (manifests.some((manifest) => !manifest)) {
    throw new Error(`Frontend shadow ${run.stage} output manifest is unavailable`);
  }
  return manifests as ArtifactManifest[];
}

async function assertFamilyOutputs(
  store: ShadowStore,
  run: PipelineStageRunRecord,
  sourceStorageMode: SourceStorageMode,
  artifactStore?: ArtifactStore
): Promise<ArtifactManifest[]> {
  const manifests = await manifestsForRun(store, run);
  const expectedKinds = new Set(frontendStageArtifactKinds(run.stage, SHADOW_FAMILIES, sourceStorageMode));
  const familyManifests = manifests.filter((manifest) => expectedKinds.has(manifest.kind));
  assertFrontendArtifactFamily(run.stage, SHADOW_FAMILIES, familyManifests, sourceStorageMode);
  for (const manifest of familyManifests) {
    if (manifest.workspaceId !== run.workspaceId || manifest.projectId !== run.projectId
      || manifest.snapshotId !== run.snapshotId || manifest.stage !== run.stage) {
      throw new Error(`Frontend shadow ${run.stage} output crosses its persisted scope`);
    }
    if (artifactStore) await artifactStore.getJson(manifest);
  }
  return familyManifests;
}

async function upstreamManifestIds(
  store: ShadowStore,
  run: PipelineStageRunRecord,
  stage: Exclude<BuildStage, "convert">,
  sourceStorageMode: SourceStorageMode,
  artifactStore?: ArtifactStore
): Promise<string[]> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const manifests = await Promise.all(UPSTREAM_STAGES[stage].map(async (upstreamStage) =>
    assertFamilyOutputs(store, completedRun(runs, upstreamStage), sourceStorageMode, artifactStore)
  ));
  return manifests.flat().map((manifest) => manifest.id).sort();
}

function purposeDigest(build: BuildRecord) {
  return {
    kind: build.purpose.kind,
    feedbackIds: build.purpose.feedbackIds,
    remediationIds: build.purpose.remediationContext?.map((context) => context.remediationId) ?? []
  };
}

export function frontendShadowInputDigest(input: {
  stage: Exclude<BuildStage, "convert">;
  snapshotId: string;
  build: BuildRecord;
  upstreamManifestIds: readonly string[];
}): string {
  return pipelineInputDigest({
    stage: input.stage,
    snapshotId: input.snapshotId,
    upstreamManifestIds: input.upstreamManifestIds,
    parserConfigVersion: [
      "frontend-shadow-v2",
      ...SHADOW_FAMILIES,
      `ir-${FRONTEND_V2_IR_SCHEMA_VERSION}`,
      `graph-${FRONTEND_V2_GRAPH_SCHEMA_VERSION}`,
      EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST
    ].join(":"),
    purpose: purposeDigest(input.build)
  });
}

async function legacyInputDigest(
  store: ShadowStore,
  run: PipelineStageRunRecord,
  build: BuildRecord,
  snapshot: SourceSnapshotRecord,
  sourceStorageMode: "legacy" | "shadow" | "active"
): Promise<string> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const ids = async (stage: BuildStage) => (await manifestsForRun(store, completedRun(runs, stage)))
    .filter((manifest) => {
      const expected = stage === "convert" && sourceStorageMode === "active"
        ? { kind: "normalized-source-refs", schemaVersion: 2 }
        : ARTIFACT_KINDS[stage]["knowledge-v1"];
      return manifest.kind === expected.kind && manifest.schemaVersion === expected.schemaVersion;
    }).map((manifest) => manifest.id);
  switch (run.stage) {
    case "extract": return knowledgeIrPipelineInputDigest(snapshot, build.purpose, await ids("convert"));
    case "tables": return tableSchemasPipelineInputDigest(snapshot, build.purpose, await ids("convert"));
    case "graph": return knowledgeGraphPipelineInputDigest(snapshot, build.purpose, [...await ids("extract"), ...await ids("tables")]);
    case "synthesize": return knowledgeSynthesisPipelineInputDigest(snapshot, build.purpose, await ids("graph"), build.allowLlm === true);
    case "index": return pipelineSearchIndexInputDigest(snapshot, build.purpose, await ids("synthesize"));
    case "lint": return pipelineKnowledgeQualityInputDigest(snapshot, build.purpose, [
      ...await ids("extract"), ...await ids("tables"), ...await ids("synthesize"), ...await ids("index")
    ]);
    case "viz": return knowledgeVisualizationPipelineInputDigest(snapshot, build.purpose, await ids("graph"));
    case "validate": return knowledgeValidationPipelineInputDigest(snapshot, build.purpose, [
      ...await ids("synthesize"), ...await ids("index"), ...await ids("lint"), ...await ids("viz")
    ]);
    case "package": return knowledgePackagePipelineInputDigest(snapshot, build.purpose, await ids("validate"));
    case "convert": throw new Error("Convert is shared by both artifact families");
  }
}

export function createKnowledgeV1StoreView<T extends ShadowStore>(
  store: T,
  convertSourceKind: "normalized-sources" | "normalized-source-refs" = "normalized-sources"
): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "listPipelineStageRuns") {
        return async (workspaceId: string, projectId: string, buildId: string) => {
          const runs = await target.listPipelineStageRuns(workspaceId, projectId, buildId);
          return Promise.all(runs.map(async (run) => {
            const manifests = await manifestsForRun(target, run);
            const expected = run.stage === "convert" && convertSourceKind === "normalized-source-refs"
              ? { kind: "normalized-source-refs", schemaVersion: 2 }
              : ARTIFACT_KINDS[run.stage]["knowledge-v1"];
            return {
              ...run,
              outputManifestIds: manifests.filter((manifest) =>
                manifest.kind === expected.kind && manifest.schemaVersion === expected.schemaVersion
              ).map((manifest) => manifest.id)
            };
          }));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function packageArtifacts(
  store: ShadowStore,
  run: PipelineStageRunRecord,
  legacyPackage: ArtifactManifest,
  sourceStorageMode: SourceStorageMode
): Promise<Record<string, string[]>> {
  const runs = await store.listPipelineStageRuns(run.workspaceId, run.projectId, run.buildId);
  const entries = await Promise.all(BUILD_STAGES.map(async (stage) => {
    const manifests = stage === "package"
      ? [legacyPackage]
      : await assertFamilyOutputs(store, completedRun(runs, stage), sourceStorageMode);
    return [stage, manifests.map((manifest) => manifest.id).sort()] as const;
  }));
  return Object.fromEntries(entries);
}

async function upstreamAnalyzerManifestDigest(
  input: { store: ShadowStore; artifactStore: ArtifactStore },
  manifestIds: readonly string[]
): Promise<string> {
  const digests = new Set<string>();
  for (const artifactId of manifestIds) {
    const manifest = await input.store.findArtifactById(artifactId);
    if (!manifest) throw new Error("Frontend upstream manifest is unavailable");
    const expected = ARTIFACT_KINDS[manifest.stage]["frontend-v2"];
    if (manifest.kind !== expected.kind || manifest.schemaVersion !== expected.schemaVersion) continue;
    const value = await input.artifactStore.getJson(manifest);
    if (value && typeof value === "object" && "analyzerManifestDigest" in value
      && typeof value.analyzerManifestDigest === "string"
      && value.analyzerManifestDigest !== EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST) {
      digests.add(value.analyzerManifestDigest);
    }
  }
  if (digests.size > 1) throw new Error("Frontend upstream analyzer manifests disagree");
  return [...digests][0] ?? EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST;
}

async function frontendUpstreamValue(
  input: { store: ShadowStore; artifactStore: ArtifactStore },
  manifestIds: readonly string[],
  stage: BuildStage
): Promise<unknown> {
  const expected = ARTIFACT_KINDS[stage]["frontend-v2"];
  for (const artifactId of manifestIds) {
    const manifest = await input.store.findArtifactById(artifactId);
    if (manifest?.kind === expected.kind && manifest.schemaVersion === expected.schemaVersion) {
      return input.artifactStore.getJson(manifest);
    }
  }
  throw new Error(`Frontend shadow upstream ${stage} artifact is unavailable`);
}

function irFromGraph(value: ReturnType<typeof buildFrontendGraph>): FrontendIR {
  return {
    schemaVersion: 2,
    snapshotId: value.snapshotId,
    analyzerManifestDigest: value.analyzerManifestDigest,
    analyzerManifest: [...new Map(value.nodes.flatMap((node) => node.provenance)
      .map((item) => [JSON.stringify(item), item])).values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    entities: value.nodes,
    edges: value.edges
  };
}

export { assertFrontendCandidateValid } from "./compatibility.js";

export function createFrontendShadowStageExecutor(input: {
  store: ShadowStore;
  artifactStore: ArtifactStore;
  legacy: PipelineStageExecutor;
  frontendParser?: FrontendParserClient;
  sourceStorageMode?: "legacy" | "shadow" | "active";
  sourceBlobReader?: SourceBlobReader;
  actorId?: string;
}): PipelineStageExecutor {
  return async (run) => {
    if (run.stage === "convert") return input.legacy(run);
    const [build, snapshot] = await Promise.all([
      input.store.getBuild(run.workspaceId, run.buildId),
      input.store.findSnapshotById(run.workspaceId, run.snapshotId)
    ]);
    if (!build || !snapshot) throw new Error("Frontend shadow stage build or snapshot is unavailable");
    const persistedLegacyDigest = await legacyInputDigest(
      input.store, run, build, snapshot, input.sourceStorageMode ?? "legacy"
    );
    if (run.inputDigest === persistedLegacyDigest) return input.legacy(run);
    const sourceStorageMode = input.sourceStorageMode ?? "legacy";
    const upstreamIds = await upstreamManifestIds(
      input.store, run, run.stage, sourceStorageMode, input.artifactStore
    );
    const shadowDigest = frontendShadowInputDigest({
      stage: run.stage, snapshotId: snapshot.id, build, upstreamManifestIds: upstreamIds
    });
    if (run.inputDigest !== shadowDigest) throw new Error("Frontend shadow stage input digest does not match enabled families");

    let projectAnalysis: Record<string, unknown> | null = null;
    let frontendIr: z.infer<typeof frontendIrSchema> | null = null;
    if (run.stage === "extract" && input.frontendParser) {
      const upstreamSources = await Promise.all(upstreamIds.map(async (artifactId) => {
        const manifest = await input.store.findArtifactById(artifactId);
        if (!manifest) throw new Error("Frontend parser normalized source artifact is unavailable");
        return { manifest, value: await input.artifactStore.getJson(manifest) };
      }));
      const referenceSource = upstreamSources.find(({ manifest }) =>
        manifest.kind === "normalized-source-refs" && manifest.schemaVersion === 2
      );
      let normalized: z.infer<typeof parserNormalizedSourcesSchema>["sources"];
      if (referenceSource) {
        if (!input.sourceBlobReader) throw new Error("Frontend parser source blob reader is unavailable");
        const references = normalizedSourceReferencesSchema.parse(referenceSource.value);
        if (references.snapshotId !== run.snapshotId) throw new Error("Frontend parser source references cross snapshots");
        normalized = await Promise.all(references.sources.filter((source) =>
          ![".csv", ".xlsx"].includes(source.path.slice(source.path.lastIndexOf(".")).toLowerCase())
        ).map(async (source) => ({
          path: source.path,
          content: new TextDecoder("utf-8", { fatal: true }).decode(
            await input.sourceBlobReader!.read({
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              snapshotId: run.snapshotId
            }, source)
          ),
          blobHash: source.blobHash
        })));
      } else {
        const inlineSource = upstreamSources.find(({ manifest }) =>
          manifest.kind === "normalized-sources" && manifest.schemaVersion === 1
        );
        if (!inlineSource) {
          throw new Error("Frontend parser normalized source artifact is unavailable");
        }
        normalized = parserNormalizedSourcesSchema.parse(inlineSource.value).sources;
      }
      const cache = new SourceAnalysisCache(input.store);
      const cachedAnalyses = (await Promise.all(normalized.filter((source) => isTypedSource(source.path)).map(async (source) => {
        const parserConfigDigest = typeScriptSyntaxParserConfigDigest(source.path);
        const facts = await cache.get({
          workspaceId: run.workspaceId,
          contentHash: source.blobHash.toLowerCase(),
          analyzerId: "typescript-syntax",
          analyzerVersion: "1.0.0",
          parserConfigDigest
        });
        return facts ? {
          path: source.path,
          blobHash: source.blobHash.toLowerCase(),
          analyzerId: "typescript-syntax" as const,
          analyzerVersion: "1.0.0" as const,
          parserConfigDigest,
          facts
        } : null;
      }))).filter((item): item is NonNullable<typeof item> => item !== null);
      const parserResult = parserRuntimeResultSchema.parse(await input.frontendParser.analyze({
        snapshotId: run.snapshotId,
        analyzerIds: [
          "frontend-project",
          "frontend-project-core",
          "typescript-core",
          "html-core",
          "style-core",
          "react-core",
          "react-router-core",
          "state-data-core",
          "visualization-core",
          "tooling-test-core"
        ],
        sources: normalized.map((source) => ({
          path: source.path,
          contentBase64: Buffer.from(source.content, "utf8").toString("base64"),
          blobHash: source.blobHash
        })),
        cachedAnalyses
      }));
      if (parserResult.snapshotId !== run.snapshotId) {
        throw new Error("Frontend parser result crosses snapshots");
      }
      if (parserResult.outputs.length !== 1) throw new Error("Frontend project analyzer output is missing");
      const output = parserResult.outputs[0]!;
      if (output.frontendIr.snapshotId !== run.snapshotId) throw new Error("Frontend IR crosses snapshots");
      frontendIr = output.frontendIr;
      const sourceByPath = new Map(normalized.map((source) => [source.path, source]));
      const bindings = await Promise.all(output.files.map(async (file) => {
        const source = sourceByPath.get(file.path);
        if (!source || source.blobHash.toLowerCase() !== file.blobHash.toLowerCase()
          || typeScriptSyntaxParserConfigDigest(file.path) !== file.parserConfigDigest) {
          throw new Error("Frontend source analysis does not match normalized sources");
        }
        const record = await cache.put({
          workspaceId: run.workspaceId,
          contentHash: file.blobHash.toLowerCase(),
          analyzerId: "typescript-syntax",
          analyzerVersion: "1.0.0",
          parserConfigDigest: file.parserConfigDigest
        }, file.facts);
        return {
          path: file.path,
          snapshotId: run.snapshotId,
          blobHash: file.blobHash.toLowerCase(),
          factsDigest: record.factsDigest
        };
      }));
      projectAnalysis = {
        analyzerId: output.analyzerId,
        analyzerVersion: output.analyzerVersion,
        projectManifest: output.projectManifest,
        projectReferences: output.projectReferences,
        resolutions: output.resolutions,
        sourceAnalysisBindings: bindings
      };
    }

    const legacyResult = await input.legacy({
      ...run,
      inputDigest: persistedLegacyDigest
    });
    if (legacyResult.outputManifestIds?.length !== 1) {
      throw new Error(`Frontend shadow ${run.stage} requires exactly one knowledge-v1 output`);
    }
    const legacyManifest = await input.store.findArtifactById(legacyResult.outputManifestIds[0]!);
    const expectedLegacy = ARTIFACT_KINDS[run.stage]["knowledge-v1"];
    if (!legacyManifest || legacyManifest.kind !== expectedLegacy.kind
      || legacyManifest.schemaVersion !== expectedLegacy.schemaVersion) {
      throw new Error(`Frontend shadow ${run.stage} knowledge-v1 output is invalid`);
    }
    const expected = ARTIFACT_KINDS[run.stage]["frontend-v2"];
    const analyzerManifestDigest = frontendIr?.analyzerManifestDigest
      ?? await upstreamAnalyzerManifestDigest(input, upstreamIds);
    const baseValue = {
      schemaVersion: 2 as const,
      family: "frontend-v2" as const,
      stage: run.stage,
      snapshotId: run.snapshotId,
      analyzerManifestDigest,
      upstreamManifestIds: upstreamIds,
      sourceArtifactId: legacyManifest.id,
      sourceStorageMode
    };
    let value: unknown;
    switch (run.stage) {
      case "extract":
        value = {
          ...(frontendIr ?? {
            schemaVersion: 2,
            snapshotId: run.snapshotId,
            analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
            analyzerManifest: [],
            entities: [],
            edges: []
          }),
          ...(projectAnalysis ? { projectAnalysis } : {})
        };
        break;
      case "graph":
        value = buildFrontendGraph(frontendIrSchema.parse(await frontendUpstreamValue(input, upstreamIds, "extract")));
        break;
      case "synthesize": {
        const graph = frontendGraphV2Schema.parse(await frontendUpstreamValue(input, upstreamIds, "graph"));
        value = generateFrontendKnowledge(irFromGraph(graph));
        break;
      }
      case "index": {
        const knowledge = await frontendUpstreamValue(input, upstreamIds, "synthesize") as ReturnType<typeof generateFrontendKnowledge>;
        value = {
          schemaVersion: 2,
          snapshotId: run.snapshotId,
          analyzerManifestDigest,
          documents: buildFrontendSearchDocuments(knowledge.pages)
        };
        break;
      }
      case "lint": {
        const ir = frontendIrSchema.parse(await frontendUpstreamValue(input, upstreamIds, "extract"));
        value = { ...assessFrontendKnowledgeQuality(ir), analyzerManifestDigest };
        break;
      }
      case "viz": {
        const graph = frontendGraphV2Schema.parse(await frontendUpstreamValue(input, upstreamIds, "graph"));
        value = {
          schemaVersion: 2,
          snapshotId: run.snapshotId,
          analyzerManifestDigest,
          routeIds: graph.nodes.filter((node) => node.kind === "route").map((node) => node.id),
          componentIds: graph.nodes.filter((node) => node.kind === "component").map((node) => node.id),
          visualizationIds: graph.nodes.filter((node) => node.kind === "visualization").map((node) => node.id),
          factEdgeIds: graph.edges.filter((edge) => edge.evidenceClass === "fact").map((edge) => edge.id)
        };
        break;
      }
      case "validate": {
        const graph = frontendGraphV2Schema.parse(await frontendUpstreamValue(input, upstreamIds, "graph"));
        const knowledge = await frontendUpstreamValue(input, upstreamIds, "synthesize") as ReturnType<typeof generateFrontendKnowledge>;
        const search = await frontendUpstreamValue(input, upstreamIds, "index") as {
          documents: Array<{ citations: Array<{ snapshotId: string; path: string; startLine: number; endLine: number; blobHash: string }> }>;
        };
        const quality = await frontendUpstreamValue(input, upstreamIds, "lint") as ReturnType<typeof assessFrontendKnowledgeQuality>;
        const graphReferences = [
          ...graph.nodes.flatMap((node) => node.sourceRefs),
          ...graph.edges.flatMap((edge) => edge.sourceRefs)
        ];
        const references = [
          ...graphReferences,
          ...knowledge.pages.flatMap((page) => [
            ...page.citations,
            ...page.items.flatMap((item) => item.sourceRefs),
            ...page.chunks.flatMap((chunk) => chunk.citations)
          ]),
          ...search.documents.flatMap((document) => document.citations),
          ...quality.issues.flatMap((issue) => issue.sourceRefs)
        ];
        const referencedPaths = new Set(references.map((reference) => reference.path));
        const sources = await loadFrontendSourceDescriptors({
          snapshot,
          files: (await input.store.listSnapshotFiles(run.workspaceId, run.snapshotId))
            .filter((file) => referencedPaths.has(file.path))
        });
        const invalidReferenceCount = references.filter((reference) => !frontendSourceReferenceIsValid(
          reference, run.snapshotId, sources
        )).length;
        value = {
          ...baseValue,
          valid: graph.nodes.every((node) => node.sourceRefs.length > 0)
            && graph.edges.filter((edge) => edge.evidenceClass === "fact")
              .every((edge) => edge.sourceRefs.length > 0)
            && knowledge.pages.every((page) => page.citations.length > 0
            && page.chunks.every((chunk) => chunk.citations.length > 0))
            && references.length > 0
            && invalidReferenceCount === 0,
          pageCount: knowledge.pages.length,
          issueCount: quality.issues.length,
          graphReferenceCount: graphReferences.length,
          checkedReferenceCount: references.length,
          invalidReferenceCount
        };
        break;
      }
      case "package": {
        const validation = frontendValidationV2Schema.parse(
          await frontendUpstreamValue(input, upstreamIds, "validate")
        );
        assertFrontendCandidateValid(validation);
        assertFrontendValidationProvenance(validation, {
          snapshotId: run.snapshotId,
          analyzerManifestDigest: baseValue.analyzerManifestDigest
        });
        value = {
            ...baseValue,
            irSchemaVersion: FRONTEND_V2_IR_SCHEMA_VERSION,
            graphSchemaVersion: FRONTEND_V2_GRAPH_SCHEMA_VERSION,
            artifacts: await packageArtifacts(input.store, run, legacyManifest, sourceStorageMode)
          };
        break;
      }
      case "tables":
        value = baseValue;
        break;
    }
    const companion = await input.artifactStore.putJson({
      manifest: {
        id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId,
        snapshotId: run.snapshotId, buildId: run.buildId, stage: run.stage,
        kind: expected.kind, schemaVersion: expected.schemaVersion, inputDigest: run.inputDigest,
        contentDigest: "0".repeat(64), storageKey: "pending", sourceRefs: legacyManifest.sourceRefs,
        producer: "deterministic", createdAt: new Date().toISOString()
      },
      value,
      actorId: input.actorId
    });
    return {
      outputManifestIds: [legacyManifest.id, companion.manifest.id],
      reused: legacyResult.reused === true && companion.reused
    };
  };
}

export function createFrontendShadowStageInputPlanner(
  store: ShadowStore,
  sourceStorageMode: SourceStorageMode = "legacy"
): PipelineStageInputPlanner {
  return {
    async nextInputDigest({ currentRun, build, nextStage, outputManifestIds }) {
      if (nextStage === "convert") throw new Error("Convert cannot follow another pipeline stage");
      const snapshot = await store.findSnapshotById(currentRun.workspaceId, currentRun.snapshotId);
      if (!snapshot) throw new Error("Frontend shadow stage snapshot is unavailable");
      const runs = await store.listPipelineStageRuns(currentRun.workspaceId, currentRun.projectId, currentRun.buildId);
      const current: PipelineStageRunRecord = {
        ...currentRun,
        status: "succeeded",
        outputManifestIds: [...outputManifestIds]
      };
      const visibleRuns = [...runs.filter((run) => run.id !== currentRun.id), current];
      const ids = (await Promise.all(UPSTREAM_STAGES[nextStage].map(async (stage) => {
        const completed = stage === current.stage ? current : completedRun(visibleRuns, stage);
        return (await assertFamilyOutputs(store, completed, sourceStorageMode)).map((manifest) => manifest.id);
      }))).flat().sort();
      return frontendShadowInputDigest({ stage: nextStage, snapshotId: snapshot.id, build, upstreamManifestIds: ids });
    }
  };
}

export function createFrontendModeStageInputPlanner(
  store: ShadowStore,
  modeForProject: (workspaceId: string, projectId: string) => Promise<FrontendKnowledgeMode>,
  sourceStorageMode: SourceStorageMode = "legacy"
): PipelineStageInputPlanner {
  const legacy = createB02StageInputPlanner(store, sourceStorageMode);
  const shadow = createFrontendShadowStageInputPlanner(store, sourceStorageMode);
  return {
    async nextInputDigest(input) {
      if (input.currentRun.stage === "convert") {
        const mode = await modeForProject(input.currentRun.workspaceId, input.currentRun.projectId);
        return mode === "legacy"
          ? legacy.nextInputDigest(input)
          : shadow.nextInputDigest(input);
      }
      const manifests = await Promise.all(input.outputManifestIds.map((id) => store.findArtifactById(id)));
      if (manifests.some((manifest) => !manifest)) {
        throw new Error(`Frontend ${input.currentRun.stage} output manifest is unavailable`);
      }
      const expectedFrontend = ARTIFACT_KINDS[input.currentRun.stage]["frontend-v2"];
      const continuesFrontendV2 = manifests.some((manifest) => manifest?.kind === expectedFrontend.kind
        && manifest.schemaVersion === expectedFrontend.schemaVersion);
      if (continuesFrontendV2) {
        await assertFamilyOutputs(store, {
          ...input.currentRun,
          status: "succeeded",
          outputManifestIds: [...input.outputManifestIds]
        }, sourceStorageMode);
      } else {
        const expectedLegacy = ARTIFACT_KINDS[input.currentRun.stage]["knowledge-v1"];
        if (manifests.length !== 1 || manifests[0]?.kind !== expectedLegacy.kind
          || manifests[0].schemaVersion !== expectedLegacy.schemaVersion
          || manifests[0].workspaceId !== input.currentRun.workspaceId
          || manifests[0].projectId !== input.currentRun.projectId
          || manifests[0].snapshotId !== input.currentRun.snapshotId) {
          throw new Error(`Frontend ${input.currentRun.stage} output family is invalid`);
        }
      }
      return continuesFrontendV2
        ? shadow.nextInputDigest(input)
        : legacy.nextInputDigest(input);
    }
  };
}
