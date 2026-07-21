import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service.js";
import { ParserClient } from "./knowledge/frontend/runtime/parser-client.js";
import { analyzeWorkerRequest } from "./knowledge/frontend/runtime/analyzer-worker.js";
import {
  createFrontendShadowStageExecutor,
  createFrontendShadowStageInputPlanner,
  createKnowledgeV1StoreView
} from "./knowledge/frontend/shadow-stage.js";
import { ArtifactStore } from "./knowledge/pipeline/artifact-store.js";
import {
  createNormalizedSourcesStageExecutor,
  normalizedSourcesPipelineInputDigest
} from "./knowledge/pipeline/convert-stage.js";
import { createKnowledgeIrStageExecutor } from "./knowledge/pipeline/extract-stage.js";
import { createKnowledgeGraphStageExecutor } from "./knowledge/pipeline/graph-stage.js";
import { createPipelineSearchIndexStageExecutor } from "./knowledge/pipeline/index-stage.js";
import { createKnowledgePackageStageExecutor } from "./knowledge/pipeline/package-stage.js";
import { createKnowledgeQualityStageExecutor } from "./knowledge/pipeline/quality-stage.js";
import { createPipelineStageExecutor } from "./knowledge/pipeline/stage-executor.js";
import { createKnowledgeSynthesisStageExecutor } from "./knowledge/pipeline/synthesize-stage.js";
import { createTableSchemasStageExecutor } from "./knowledge/pipeline/tables-stage.js";
import { createKnowledgeValidationStageExecutor } from "./knowledge/pipeline/validate-stage.js";
import { createKnowledgeVisualizationStageExecutor } from "./knowledge/pipeline/viz-stage.js";
import {
  PipelineStageWorker,
  type PipelineStageJob,
  type PipelineStageJobQueue
} from "./knowledge/pipeline/worker.js";
import { MemoryAppStore } from "./persistence/memory-store.js";

const execute = promisify(execFile);
const fixtureSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/code-intelligence");
const frontendFixtureSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/frontend/react-vite");
const fixturePath = "/tmp/devkh-e2e-fixture";

class ImmediateQueue implements BuildJobQueue {
  private handler: ((buildId: string) => Promise<void>) | null = null;
  async start(handler: (buildId: string) => Promise<void>) { this.handler = handler; }
  async send(buildId: string) {
    const handler = this.handler;
    if (handler) setTimeout(() => void handler(buildId), 20);
  }
  async stop() { this.handler = null; }
}

class ManualPipelineQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];
  async send(job: PipelineStageJob) { this.sent.push(job); }
  async start() {}
  async stop() {}
}

await rm(fixturePath, { recursive: true, force: true });
await mkdir(fixturePath, { recursive: true });
await cp(fixtureSource, fixturePath, { recursive: true });
await execute("git", ["init", "-b", "main"], { cwd: fixturePath });
await execute("git", ["add", "."], { cwd: fixturePath });
await execute("git", ["-c", "user.name=DevKH Tests", "-c", "user.email=tests@devkh.local", "commit", "-m", "fixture"], { cwd: fixturePath });

const store = new MemoryAppStore();
const frontendArtifactRoot = "/tmp/devkh-e2e-frontend-artifacts";
await rm(frontendArtifactRoot, { recursive: true, force: true });
const frontendArtifactStore = new ArtifactStore(frontendArtifactRoot, store);
await frontendArtifactStore.initialize();
const queue = new ImmediateQueue();
const buildService = new BuildService(store, queue);
await buildService.start();
const app = buildServer({
  store,
  buildService,
  masterKey: Buffer.alloc(32, 12).toString("base64"),
  sessionSecret: "deterministic-e2e-session-secret",
  dataDir: "/tmp/devkh-e2e-data",
  nodeEnv: "test",
  qualityArtifactReader: frontendArtifactStore
});

app.get("/__test__/fixture", async () => ({ path: fixturePath }));
app.post("/__test__/feedback", async (_request, reply) => {
  const workspace = await store.defaultWorkspace();
  const repository = workspace ? await store.currentRepository(workspace.id) : null;
  const release = workspace && repository ? await store.currentRelease(workspace.id, repository.id) : null;
  if (!workspace || !release) return reply.code(409).send({ error: "Publish a release first" });
  const matches = await store.searchKnowledge(workspace.id, repository!.id, "add", release.id);
  const citations = [...new Map(matches.flatMap((match) => match.citations).map((citation) => [
    `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.blobHash}`,
    citation
  ])).values()].slice(0, 5);
  return reply.code(201).send({ feedback: await store.createFeedback({
    workspaceId: workspace.id,
    releaseId: release.id,
    query: "How do I deploy the service?",
    reason: "Deployment steps are incomplete",
    expected: "A verified command sequence",
    citations
  }) });
});

app.post("/__test__/graph", async (_request, reply) => {
  const workspace = await store.defaultWorkspace();
  const repository = workspace ? await store.currentRepository(workspace.id) : null;
  const release = workspace && repository ? await store.currentRelease(workspace.id, repository.id) : null;
  if (!workspace || !repository || !release || !release.publishedAt) return reply.code(409).send({ error: "Publish a release first" });
  if (await store.getKnowledgeGraph(workspace.id, repository.projectId, release.buildId)) return { created: false };
  const source = (await store.listSnapshotFiles(workspace.id, release.snapshotId)).at(0);
  if (!source) return reply.code(409).send({ error: "Release snapshot has no source files" });
  const sourceRef = {
    snapshotId: release.snapshotId,
    path: source.path,
    startLine: 1,
    endLine: 1,
    blobHash: source.contentHash
  };
  const moduleId = `e2e-module-${release.buildId}`;
  await store.saveKnowledgeGraph({
    workspaceId: workspace.id,
    projectId: repository.projectId,
    snapshotId: release.snapshotId,
    buildId: release.buildId,
    graph: {
      nodes: [{
        id: moduleId,
        projectId: repository.projectId,
        snapshotId: release.snapshotId,
        kind: "module",
        name: path.posix.basename(source.path),
        qualifiedName: source.path,
        candidate: false,
        sourceRefs: [sourceRef],
        attributes: { language: source.language ?? "unknown" }
      }],
      edges: []
    }
  });
  return { created: true };
});

app.post("/__test__/parser-unavailable-shadow", async (_request, reply) => {
  const workspace = await store.defaultWorkspace();
  const repository = workspace ? await store.currentRepository(workspace.id) : null;
  const release = workspace && repository ? await store.currentRelease(workspace.id, repository.id) : null;
  if (!workspace || !repository || !release) return reply.code(409).send({ error: "Publish a release first" });
  const build = await store.getBuild(workspace.id, release.buildId);
  if (!build) return reply.code(409).send({ error: "Release build is unavailable" });
  const unavailableSocket = "/tmp/devkh-e2e-parser-unavailable.sock";
  await rm(unavailableSocket, { force: true });
  const snapshot = await store.findSnapshotById(workspace.id, build.snapshotId);
  if (!snapshot) return reply.code(409).send({ error: "Release snapshot is unavailable" });
  const files = await store.listSnapshotFiles(workspace.id, snapshot.id);
  const pipelineQueue = new ManualPipelineQueue();
  const knowledgeV1Store = createKnowledgeV1StoreView(store);
  const legacy = createPipelineStageExecutor({
    convert: createNormalizedSourcesStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    extract: createKnowledgeIrStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore })
  });
  const worker = new PipelineStageWorker(
    store,
    pipelineQueue,
    createFrontendShadowStageExecutor({
      store,
      artifactStore: frontendArtifactStore,
      legacy,
      frontendParser: new ParserClient({ socketPath: unavailableSocket, connectTimeoutMs: 50 })
    }),
    ["convert", "extract"],
    5_000,
    createFrontendShadowStageInputPlanner(store)
  );
  await worker.schedule({
    workspaceId: workspace.id,
    projectId: repository.projectId,
    snapshotId: snapshot.id,
    buildId: build.id,
    inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
  });
  for (let index = 0; index < pipelineQueue.sent.length; index += 1) {
    await worker.process(pipelineQueue.sent[index]!);
  }
  const stages = await store.listPipelineStageRuns(workspace.id, repository.projectId, build.id);
  const failed = stages.find((stage) => stage.stage === "extract" && stage.status === "failed");
  if (failed?.errorCode !== "PARSER_RUNTIME_UNAVAILABLE") {
    return reply.code(500).send({ error: "Production shadow parser failure was not persisted" });
  }
  return {
    stage: failed,
    releaseIdBefore: release.id,
    releaseIdAfter: (await store.currentRelease(workspace.id, repository.id))?.id ?? null
  };
});

app.post("/__test__/frontend-shadow", async (_request, reply) => {
  const workspace = await store.defaultWorkspace();
  const repository = workspace ? await store.currentRepository(workspace.id) : null;
  const releaseBefore = workspace && repository ? await store.currentRelease(workspace.id, repository.id) : null;
  if (!workspace || !repository || !releaseBefore) return reply.code(409).send({ error: "Publish a release first" });
  const sourcePaths: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory)) {
      const absolute = path.join(directory, entry);
      if ((await stat(absolute)).isDirectory()) await visit(absolute);
      else sourcePaths.push(path.relative(frontendFixtureSource, absolute).split(path.sep).join("/"));
    }
  };
  await visit(frontendFixtureSource);
  const snapshotId = randomUUID();
  const commitSha = "b".repeat(40);
  const files = await Promise.all(sourcePaths.map(async (sourcePath) => {
    const bytes = await readFile(path.join(frontendFixtureSource, sourcePath));
    return {
      id: randomUUID(), workspaceId: workspace.id, snapshotId, path: sourcePath,
      byteSize: bytes.byteLength, contentHash: createHash("sha256").update(bytes).digest("hex"),
      language: path.extname(sourcePath).slice(1) || null
    };
  }));
  const snapshot = await store.createSnapshot({
    snapshot: {
      id: snapshotId, workspaceId: workspace.id, repositoryId: repository.id, commitSha,
      ref: "frontend-v1-demo", remoteUrl: null, commitTimestamp: new Date(), storagePath: frontendFixtureSource
    },
    files
  });
  const { build } = await store.createBuild({
    workspaceId: workspace.id, repositoryId: repository.id, snapshotId,
    snapshotPath: frontendFixtureSource, commitSha
  });
  const pipelineQueue = new ManualPipelineQueue();
  const knowledgeV1Store = createKnowledgeV1StoreView(store);
  const legacy = createPipelineStageExecutor({
    convert: createNormalizedSourcesStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    extract: createKnowledgeIrStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    tables: createTableSchemasStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    graph: createKnowledgeGraphStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    synthesize: createKnowledgeSynthesisStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    index: createPipelineSearchIndexStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    lint: createKnowledgeQualityStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    viz: createKnowledgeVisualizationStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    validate: createKnowledgeValidationStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore }),
    package: createKnowledgePackageStageExecutor({ store: knowledgeV1Store, artifactStore: frontendArtifactStore })
  });
  const worker = new PipelineStageWorker(
    store,
    pipelineQueue,
    createFrontendShadowStageExecutor({
      store,
      artifactStore: frontendArtifactStore,
      legacy,
      frontendParser: {
        analyze: async (input) => analyzeWorkerRequest({
          ...input, type: "analyze", requestId: randomUUID()
        })
      }
    }),
    ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"],
    5_000,
    createFrontendShadowStageInputPlanner(store)
  );
  await worker.schedule({
    workspaceId: workspace.id, projectId: repository.projectId, snapshotId: snapshot.id,
    buildId: build.id, inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
  });
  for (let index = 0; index < pipelineQueue.sent.length; index += 1) {
    await worker.process(pipelineQueue.sent[index]!);
  }
  const stages = await store.listPipelineStageRuns(workspace.id, repository.projectId, build.id);
  const releaseAfter = await store.currentRelease(workspace.id, repository.id);
  if (!stages.every((stage) => ["succeeded", "reused"].includes(stage.status))) {
    return reply.code(500).send({ error: "Frontend shadow pipeline did not complete", stages });
  }
  return {
    buildId: build.id,
    stageCount: stages.length,
    releaseIdBefore: releaseBefore.id,
    releaseIdAfter: releaseAfter?.id ?? null
  };
});

app.addHook("onClose", async () => buildService.stop());
await app.listen({ host: "127.0.0.1", port: 3000 });
