import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service.js";
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

app.addHook("onClose", async () => buildService.stop());
await app.listen({ host: "127.0.0.1", port: 3000 });
