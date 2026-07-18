import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service.js";
import { ParserClient } from "./knowledge/frontend/runtime/parser-client.js";
import { MemoryAppStore } from "./persistence/memory-store.js";

const execute = promisify(execFile);
const fixtureSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/code-intelligence");
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

await rm(fixturePath, { recursive: true, force: true });
await mkdir(fixturePath, { recursive: true });
await cp(fixtureSource, fixturePath, { recursive: true });
await execute("git", ["init", "-b", "main"], { cwd: fixturePath });
await execute("git", ["add", "."], { cwd: fixturePath });
await execute("git", ["-c", "user.name=DevKH Tests", "-c", "user.email=tests@devkh.local", "commit", "-m", "fixture"], { cwd: fixturePath });

const store = new MemoryAppStore();
const queue = new ImmediateQueue();
const buildService = new BuildService(store, queue);
await buildService.start();
const app = buildServer({
  store,
  buildService,
  masterKey: Buffer.alloc(32, 12).toString("base64"),
  sessionSecret: "deterministic-e2e-session-secret",
  dataDir: "/tmp/devkh-e2e-data",
  nodeEnv: "test"
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
  let parserError: { code: string; message: string } | undefined;
  try {
    await new ParserClient({ socketPath: unavailableSocket, connectTimeoutMs: 50 }).analyze({
      snapshotId: build.snapshotId,
      analyzerIds: [],
      sources: []
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      parserError = { code: String(error.code), message: String(error.message) };
    }
  }
  if (parserError?.code !== "PARSER_RUNTIME_UNAVAILABLE") {
    return reply.code(500).send({ error: "Parser unavailability could not be reproduced" });
  }
  const run = await store.createStageRun({
    workspaceId: workspace.id,
    projectId: repository.projectId,
    snapshotId: build.snapshotId,
    buildId: build.id,
    stage: "extract",
    attempt: 1,
    inputDigest: "f".repeat(64)
  });
  const running = await store.transitionStageRun(
    workspace.id, repository.projectId, run.id, "queued", "running"
  );
  if (!running) return reply.code(409).send({ error: "Shadow stage could not start" });
  const failed = await store.transitionStageRun(
    workspace.id,
    repository.projectId,
    run.id,
    "running",
    "failed",
    { errorCode: parserError.code, errorDetail: parserError.message }
  );
  return { stage: failed };
});

app.addHook("onClose", async () => buildService.stop());
await app.listen({ host: "127.0.0.1", port: 3000 });
