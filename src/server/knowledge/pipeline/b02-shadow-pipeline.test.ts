import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ArtifactStore } from "./artifact-store";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "./convert-stage";
import { createKnowledgeIrStageExecutor } from "./extract-stage";
import { createKnowledgeGraphStageExecutor } from "./graph-stage";
import { createPipelineStageExecutor } from "./stage-executor";
import { createKnowledgeSynthesisStageExecutor } from "./synthesize-stage";
import { createPipelineSearchIndexStageExecutor } from "./index-stage";
import { createKnowledgeQualityStageExecutor } from "./quality-stage";
import { createKnowledgeVisualizationStageExecutor } from "./viz-stage";
import { createKnowledgeValidationStageExecutor } from "./validate-stage";
import { createKnowledgePackageStageExecutor } from "./package-stage";
import { createTableSchemasStageExecutor } from "./tables-stage";
import { PipelineStageWorker, type PipelineStageJob, type PipelineStageJobQueue } from "./worker";
import { SourceBlobReader } from "./source-blob-reader";
import type { ArtifactManifest } from "./contracts";
import { MemoryAppStore } from "../../persistence/memory-store";
import type { PipelineArtifactStore } from "../../persistence/store";
import {
  createFrontendShadowStageExecutor,
  createFrontendShadowStageInputPlanner,
  createKnowledgeV1StoreView,
  assertFrontendCandidateValid
} from "../frontend/shadow-stage";
import {
  assertFrontendArtifactFamily,
  createVerifiedFrontendReleaseDraft
} from "../frontend/compatibility";
import { analyzeWorkerRequest } from "../frontend/runtime/analyzer-worker";
import { SourceBlobStore } from "../../uploads/source-blob-store";

const directories: string[] = [];

class FakeQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];
  async send(job: PipelineStageJob): Promise<void> { this.sent.push(job); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

type PipelineStore = MemoryAppStore & PipelineArtifactStore & {
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? directorySize(entryPath) : (await stat(entryPath)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("B02 shadow pipeline", () => {
  test("refuses to package a candidate whose complete reference validation failed", () => {
    expect(() => assertFrontendCandidateValid({ valid: false, invalidReferenceCount: 1 }))
      .toThrow("requires a valid candidate");
    expect(() => assertFrontendCandidateValid({ valid: true, invalidReferenceCount: 0 }))
      .toThrow("complete Graph reference evidence");
    expect(() => assertFrontendCandidateValid({
      valid: true, graphReferenceCount: 2, checkedReferenceCount: 5, invalidReferenceCount: 0
    })).not.toThrow();
  });

  test.each(["shadow", "active"] as const)(
    "persists, reuses, and verifies source %s artifact families without changing v1 graph behavior",
    async (sourceStorageMode) => {
    const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-b02-snapshot-"));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-b02-artifacts-"));
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-b02-blobs-"));
    directories.push(snapshotRoot, artifactRoot, blobRoot);
    const sourcePath = "src/app.ts";
    const source = [
      "import { useMutation } from '@tanstack/react-query';",
      "import gql from 'graphql-tag';",
      "export const DashboardOverview = gql`query DashboardOverview { dashboard { title } }`;",
      "const saveDashboard = async () => undefined;",
      "export function useSaveDashboard() { const mutation = useMutation({ mutationFn: saveDashboard }); return mutation; }",
      "export const answer = 42;",
      ""
    ].join("\n");
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    await writeFile(path.join(snapshotRoot, sourcePath), source);

    const store = new MemoryAppStore() as PipelineStore;
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const sourceBlobStore = new SourceBlobStore({ dataDir: blobRoot, catalog: store });
    await sourceBlobStore.initialize();
    const sourceBlob = await sourceBlobStore.put({ workspaceId, bytes: Buffer.from(source) });
    const sourceBlobReader = new SourceBlobReader({ catalog: store, blobStore: sourceBlobStore });
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshotId = randomUUID();
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
      },
      files: [{
        id: randomUUID(), workspaceId, snapshotId, path: sourcePath,
        byteSize: Buffer.byteLength(source), contentHash: hash(source), language: "typescript",
        sourceBlobId: sourceBlob.record.id
      }]
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const artifactStore = new ArtifactStore(artifactRoot, store);
    await artifactStore.initialize();
    const queue = new FakeQueue();
    const knowledgeV1Store = createKnowledgeV1StoreView(
      store,
      sourceStorageMode === "active" ? "normalized-source-refs" : "normalized-sources"
    );
    const legacyExecutor = createPipelineStageExecutor({
      convert: createNormalizedSourcesStageExecutor({
        store: knowledgeV1Store, artifactStore, sourceStorageMode, sourceBlobReader
      }),
      extract: createKnowledgeIrStageExecutor({ store: knowledgeV1Store, artifactStore, sourceBlobReader }),
      tables: createTableSchemasStageExecutor({ store: knowledgeV1Store, artifactStore, sourceBlobReader }),
      graph: createKnowledgeGraphStageExecutor({ store: knowledgeV1Store, artifactStore }),
      synthesize: createKnowledgeSynthesisStageExecutor({ store: knowledgeV1Store, artifactStore }),
      index: createPipelineSearchIndexStageExecutor({ store: knowledgeV1Store, artifactStore }),
      lint: createKnowledgeQualityStageExecutor({ store: knowledgeV1Store, artifactStore }),
      viz: createKnowledgeVisualizationStageExecutor({ store: knowledgeV1Store, artifactStore }),
      validate: createKnowledgeValidationStageExecutor({ store: knowledgeV1Store, artifactStore }),
      package: createKnowledgePackageStageExecutor({ store: knowledgeV1Store, artifactStore })
    });
    const parserAnalyze = vi.fn(async (request) => analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      ...request
    }));
    const worker = new PipelineStageWorker(
      store,
      queue,
      createFrontendShadowStageExecutor({
        store, artifactStore, legacy: legacyExecutor,
        frontendParser: { analyze: parserAnalyze },
        sourceStorageMode,
        sourceBlobReader
      }),
      ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"],
      5_000,
      createFrontendShadowStageInputPlanner(store, sourceStorageMode)
    );
    const files = await store.listSnapshotFiles(workspaceId, snapshot.id);
    await worker.schedule({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
    });

    for (let index = 0; index < queue.sent.length; index += 1) {
      await worker.process(queue.sent[index]!);
    }

    const runs = await store.listPipelineStageRuns(workspaceId, project.id, build.id);
    expect(parserAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: snapshot.id,
      analyzerIds: [
        "frontend-project",
        "frontend-project-core",
        "typescript-core",
        "html-core",
        "style-core",
        "react-core",
        "react-ecosystem-core",
        "react-router-core",
        "state-data-core",
        "visualization-core",
        "tooling-test-core"
      ],
      cachedAnalyses: [],
      sources: [expect.objectContaining({ path: sourcePath, blobHash: hash(source) })]
    }));
    expect(store.sourceAnalysisArtifacts).toHaveLength(1);
    expect(runs.find((run) => run.stage === "extract")?.errorDetail).toBeNull();
    expect(runs.map((run) => [run.stage, run.status])).toEqual([
      ["convert", "succeeded"], ["extract", "succeeded"], ["tables", "succeeded"], ["graph", "succeeded"],
      ["synthesize", "succeeded"], ["index", "succeeded"], ["lint", "succeeded"], ["viz", "succeeded"],
      ["validate", "succeeded"], ["package", "succeeded"]
    ]);
    for (const run of runs) {
      const manifests = await Promise.all(run.outputManifestIds.map((id) => store.findArtifactById(id)));
      expect(manifests).not.toContain(null);
      const expectedCount = run.stage === "convert" && sourceStorageMode === "active" ? 1 : 2;
      expect(manifests).toHaveLength(expectedCount);
      expect(() => assertFrontendArtifactFamily(
        run.stage,
        ["knowledge-v1", "frontend-v2"],
        manifests.filter((manifest): manifest is ArtifactManifest => manifest !== null),
        sourceStorageMode
      )).not.toThrow();
    }
    const extractRun = runs.find((run) => run.stage === "extract")!;
    const frontendExtractManifest = (await Promise.all(extractRun.outputManifestIds.map((id) =>
      store.findArtifactById(id)
    ))).find((manifest) => manifest?.kind === "frontend-ir-v2")!;
    await expect(artifactStore.getJson(frontendExtractManifest)).resolves.toMatchObject({
      projectAnalysis: {
        analyzerId: "typescript-project",
        sourceAnalysisBindings: [{
          path: sourcePath,
          snapshotId: snapshot.id,
          blobHash: hash(source),
          factsDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        }]
      }
    });
    await expect(artifactStore.getJson(frontendExtractManifest)).resolves.toMatchObject({
      entities: expect.arrayContaining([
        expect.objectContaining({ kind: "symbol", name: "answer", canonicalPath: sourcePath }),
        expect.objectContaining({
          kind: "api_operation",
          name: "DashboardOverview",
          facets: { "react-ecosystem-core": expect.objectContaining({ protocol: "graphql" }) }
        }),
        expect.objectContaining({
          kind: "api_operation",
          name: "mutation",
          completeness: "partial",
          attributes: {
            method: { state: "known", value: "MUTATION" },
            path: { state: "unknown", reason: "dynamic" }
          },
          facets: { "state-data-core": expect.objectContaining({ queryKind: "mutation", queryKey: null }) }
        })
      ]),
      analyzerManifest: expect.arrayContaining([
        expect.objectContaining({ analyzerId: "typescript-core" }),
        expect.objectContaining({ analyzerId: "react-ecosystem-core" })
      ])
    });
    const frontendValue = async (stage: string, kind: string) => {
      const run = runs.find((candidate) => candidate.stage === stage)!;
      const manifest = (await Promise.all(run.outputManifestIds.map((id) => store.findArtifactById(id))))
        .find((candidate) => candidate?.kind === kind)!;
      return artifactStore.getJson(manifest);
    };
    await expect(frontendValue("graph", "frontend-graph-v2")).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ kind: "symbol", name: "answer" })])
    });
    await expect(frontendValue("synthesize", "frontend-knowledge-pages-v2")).resolves.toMatchObject({
      pages: expect.arrayContaining([expect.objectContaining({ slug: "frontend-architecture" })])
    });
    await expect(frontendValue("index", "frontend-search-index-v2")).resolves.toMatchObject({
      documents: expect.arrayContaining([expect.objectContaining({
        title: `Frontend Architecture: ${sourcePath}`,
        content: expect.stringContaining(`application_entry: ${sourcePath}`),
        citations: expect.arrayContaining([expect.objectContaining({ path: sourcePath })]),
        metadata: expect.objectContaining({ entityId: expect.any(String) })
      })])
    });
    await expect(frontendValue("lint", "frontend-knowledge-quality-v2")).resolves.toMatchObject({
      summary: expect.objectContaining({ entities: expect.any(Number), citedEntities: expect.any(Number) })
    });
    const frontendValidation = await frontendValue("validate", "frontend-validation-v2") as {
      valid: boolean; graphReferenceCount: number; checkedReferenceCount: number; invalidReferenceCount: number;
    };
    expect(frontendValidation).toMatchObject({
      valid: true,
      graphReferenceCount: expect.any(Number),
      checkedReferenceCount: expect.any(Number),
      invalidReferenceCount: 0
    });
    expect(frontendValidation.graphReferenceCount).toBeGreaterThan(0);
    expect(frontendValidation.checkedReferenceCount).toBeGreaterThanOrEqual(frontendValidation.graphReferenceCount);
    await expect(store.getKnowledgeGraph(workspaceId, project.id, build.id)).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({
        kind: "module", name: "app.ts", qualifiedName: sourcePath
      })])
    });
    const initialArtifactBytes = await directorySize(artifactRoot);

    await store.transitionBuild(build.id, "queued", "ready");
    const { build: reusedBuild, created } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    expect(created).toBe(true);
    const queuedBeforeReuse = queue.sent.length;
    await worker.schedule({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: reusedBuild.id,
      inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, reusedBuild.purpose)
    });
    for (let index = queuedBeforeReuse; index < queue.sent.length; index += 1) {
      await worker.process(queue.sent[index]!);
    }

    expect((await store.listPipelineStageRuns(workspaceId, project.id, reusedBuild.id))
      .map((run) => [run.stage, run.status]))
      .toEqual([
        ["convert", "reused"], ["extract", "reused"], ["tables", "reused"], ["graph", "reused"],
        ["synthesize", "reused"], ["index", "reused"], ["lint", "reused"], ["viz", "reused"],
        ["validate", "reused"], ["package", "reused"]
      ]);
    const reusedRuns = await store.listPipelineStageRuns(workspaceId, project.id, reusedBuild.id);
    const packageRun = reusedRuns.find((run) => run.stage === "package")!;
    const packageArtifact = (await Promise.all(packageRun.outputManifestIds.map((id) =>
      store.findArtifactById(id)
    ))).find((manifest) => manifest?.kind === "frontend-pipeline-package")!;
    await store.transitionBuild(reusedBuild.id, "queued", "ready");
    const release = await createVerifiedFrontendReleaseDraft({
      store,
      artifactReader: artifactStore,
      workspaceId,
      repositoryId: repository!.id,
      buildId: reusedBuild.id,
      version: "frontend-v2.0.0",
      packageStageRunId: packageRun.id,
      packageArtifactId: packageArtifact.id
    });
    expect(release).toMatchObject({
      releaseArtifactFamily: "frontend-v2",
      packageStageRunId: packageRun.id,
      packageArtifactId: packageArtifact.id,
      frontendIrSchemaVersion: 2,
      frontendGraphSchemaVersion: 2
    });

    await rm(path.join(artifactStore.root, packageArtifact.storageKey));
    await expect(createVerifiedFrontendReleaseDraft({
      store,
      artifactReader: artifactStore,
      workspaceId,
      repositoryId: repository!.id,
      buildId: reusedBuild.id,
      version: "frontend-v2-missing",
      packageStageRunId: packageRun.id,
      packageArtifactId: packageArtifact.id
    })).rejects.toThrow("Artifact content is unavailable");
    expect(await store.listReleases(workspaceId, repository!.id)).toHaveLength(1);
    const reusedArtifactBytes = await directorySize(artifactRoot);
    expect(reusedArtifactBytes - initialArtifactBytes).toBeLessThanOrEqual(Math.ceil(initialArtifactBytes * 0.05));
    }
  );
});
