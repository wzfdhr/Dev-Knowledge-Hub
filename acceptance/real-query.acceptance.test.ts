import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";

import { syncRepository } from "../src/server/git/snapshot";
import { BuildService, type BuildJobQueue } from "../src/server/knowledge/build-service";
import { createMcpServer } from "../src/server/mcp-stdio";
import { MemoryAppStore } from "../src/server/persistence/memory-store";

const execute = promisify(execFile);
const fixtureSource = path.resolve("acceptance/fixture-repo");
const temporaryPaths: string[] = [];
const closeCallbacks: Array<() => Promise<void>> = [];

class InlineQueue implements BuildJobQueue {
  private handler: ((buildId: string) => Promise<void>) | null = null;
  async start(handler: (buildId: string) => Promise<void>) { this.handler = handler; }
  async send(buildId: string) {
    if (!this.handler) throw new Error("Acceptance queue is not started");
    await this.handler(buildId);
  }
  async stop() { this.handler = null; }
}

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  await Promise.all(temporaryPaths.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

test("real MCP change context identifies affected modules, conventions, and tests", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-acceptance-repo-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-acceptance-data-"));
  temporaryPaths.push(fixtureRoot, dataDir);
  await cp(fixtureSource, fixtureRoot, { recursive: true });
  await execute("git", ["init", "-b", "main"], { cwd: fixtureRoot });
  await execute("git", ["add", "."], { cwd: fixtureRoot });
  await execute("git", [
    "-c", "user.name=DevKH Acceptance", "-c", "user.email=acceptance@devkh.local",
    "commit", "-m", "deterministic fixture"
  ], { cwd: fixtureRoot, env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-11T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-11T00:00:00Z" } });
  const { stdout: commitOutput } = await execute("git", ["rev-parse", "HEAD"], { cwd: fixtureRoot });
  const commitSha = commitOutput.trim();

  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "acceptance-password-hash");
  if (!setup) throw new Error("Acceptance setup failed");
  const repository = await store.createRepository(setup.workspace.id, {
    kind: "local", name: "Acceptance fixture", path: fixtureRoot
  });
  if (!repository) throw new Error("Acceptance repository setup failed");
  const snapshot = await syncRepository({ repository, dataDir, store });

  const queue = new InlineQueue();
  const builds = new BuildService(store, queue);
  await builds.start();
  closeCallbacks.push(() => builds.stop());
  const started = await builds.startBuild({
    workspaceId: setup.workspace.id,
    repositoryId: repository.id,
    snapshotId: snapshot.snapshotId,
    snapshotPath: (await store.findSnapshotById(setup.workspace.id, snapshot.snapshotId))!.storagePath,
    commitSha
  });
  const ready = await store.getBuild(setup.workspace.id, started.build.id);
  expect(ready?.status).toBe("ready");
  const release = await store.createReleaseDraft(
    setup.workspace.id, repository.id, started.build.id, "1.0.0"
  );
  await store.publishRelease(setup.workspace.id, release.id);

  const server = createMcpServer({ store, workspaceId: setup.workspace.id });
  const client = new Client({ name: "acceptance-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeCallbacks.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "dkh_get_change_context",
    arguments: {
      task: "change the retry policy",
      paths: [
        "src/request.ts",
        "src/retry-policy.ts",
        "CONTRIBUTING.md",
        "tests/retry-policy.test.ts"
      ]
    }
  });

  expect(response.isError).not.toBe(true);
  const envelope = response.structuredContent as {
    commitSha: string;
    citations: Array<{ path: string; startLine: number; endLine: number; commitSha: string }>;
  };
  expect(envelope.commitSha).toBe(commitSha);
  expect(envelope.citations).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "src/request.ts", startLine: 1, endLine: 12, commitSha }),
    expect.objectContaining({ path: "src/retry-policy.ts", startLine: 1, endLine: 5, commitSha }),
    expect.objectContaining({ path: "CONTRIBUTING.md", startLine: 1, endLine: 4, commitSha }),
    expect.objectContaining({ path: "tests/retry-policy.test.ts", startLine: 1, endLine: 8, commitSha })
  ]));
});
