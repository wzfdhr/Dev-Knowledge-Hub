import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service";
import { generateKnowledge } from "./knowledge/generator";
import { analyzeSnapshot } from "./knowledge/intelligence";
import { createMcpServer } from "./mcp-stdio";
import { MemoryAppStore } from "./persistence/memory-store";
import type { AuditEventInput } from "./persistence/store";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/code-intelligence"
);

class ControlledQueue implements BuildJobQueue {
  sent: string[] = [];
  handler: ((buildId: string) => Promise<void>) | null = null;
  async send(buildId: string) { this.sent.push(buildId); }
  async start(handler: (buildId: string) => Promise<void>) { this.handler = handler; }
  async stop() {}
}

class FailingAuditStore extends MemoryAppStore {
  failAudit = false;

  override async recordAudit(event: AuditEventInput) {
    await super.recordAudit(event);
    if (this.failAudit) throw new Error("audit unavailable");
  }
}

async function context(store: MemoryAppStore = new MemoryAppStore()) {
  const queue = new ControlledQueue();
  const buildService = new BuildService(store, queue);
  await buildService.start();
  const app = buildServer({
    store,
    buildService,
    masterKey: Buffer.alloc(32, 8).toString("base64"),
    sessionSecret: "feedback-session-secret",
    dataDir: "/tmp/devkh-feedback",
    nodeEnv: "test"
  });
  await app.inject({
    method: "POST", url: "/api/setup",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const login = await app.inject({
    method: "POST", url: "/api/session",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const workspaceId = (await store.defaultWorkspace())!.id;
  const repository = (await store.createRepository(workspaceId, {
    kind: "local", name: "Fixture", path: fixtureRoot
  }))!;
  const index = await analyzeSnapshot(fixtureRoot, "b".repeat(40));
  const snapshotId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await store.createSnapshot({
    snapshot: {
      id: snapshotId, workspaceId, repositoryId: repository.id, commitSha: index.commitSha,
      ref: "main", remoteUrl: null, commitTimestamp: new Date(), storagePath: fixtureRoot
    },
    files: index.files.map((file, position) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(position + 1).padStart(12, "0")}`,
      workspaceId, snapshotId, path: file.path, byteSize: 1,
      contentHash: file.blobHash, language: null
    }))
  });
  const build = (await store.createBuild({
    workspaceId, repositoryId: repository.id, snapshotId,
    snapshotPath: fixtureRoot, commitSha: index.commitSha
  })).build;
  await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
  await store.transitionBuild(build.id, "queued", "ready");
  const release = await store.createReleaseDraft(workspaceId, repository.id, build.id, "1.0.0");
  await store.publishRelease(workspaceId, release.id);
  return { app, store, queue, buildService, cookie, workspaceId, repository, release };
}

describe("manual feedback workflow", () => {
  test("filters feedback and enforces the transition table", async () => {
    const { app, store, cookie, workspaceId } = await context();
    const persistence = store as unknown as {
      createFeedback(input: Record<string, unknown>): Promise<{ id: string }>;
    };
    const feedback = await persistence.createFeedback({
      workspaceId, query: "deployment", reason: "missing", expected: "steps"
    });

    const open = await app.inject({
      method: "GET", url: "/api/feedback?status=open", headers: { cookie }
    });
    expect(open.json().feedback).toHaveLength(1);

    expect((await app.inject({
      method: "PATCH", url: `/api/feedback/${feedback.id}`,
      headers: { cookie }, payload: { status: "fixed" }
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PATCH", url: `/api/feedback/${feedback.id}`,
      headers: { cookie }, payload: { status: "acknowledged" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/api/feedback/${feedback.id}`,
      headers: { cookie }, payload: { status: "fixed" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/api/feedback/${feedback.id}`,
      headers: { cookie }, payload: { status: "open" }
    })).statusCode).toBe(409);
    expect(store.auditEvents.filter((event) => event.action === "feedback.transitioned"))
      .toHaveLength(2);
    await app.close();
  });

  test("rebuilds acknowledged feedback to ready without publishing it", async () => {
    const { app, store, queue, cookie, workspaceId, release } = await context();
    const persistence = store as unknown as {
      createFeedback(input: Record<string, unknown>): Promise<{ id: string }>;
      transitionFeedback(workspaceId: string, id: string, status: string): Promise<unknown>;
    };
    const feedback = await persistence.createFeedback({
      workspaceId, query: "deployment", reason: "missing", expected: "steps"
    });
    await persistence.transitionFeedback(workspaceId, feedback.id, "acknowledged");

    const response = await app.inject({
      method: "POST", url: `/api/feedback/${feedback.id}/rebuild`, headers: { cookie }
    });
    expect(response.statusCode).toBe(202);
    const buildId = response.json().build.id as string;
    expect(queue.sent).toContain(buildId);
    await queue.handler!(buildId);
    expect((await store.getBuild(workspaceId, buildId))?.status).toBe("ready");
    expect((await store.currentRelease(workspaceId, release.repositoryId))?.id).toBe(release.id);
    expect(store.releases).toHaveLength(1);
    expect(store.auditEvents.some((event) => event.action === "feedback.rebuild_requested"))
      .toBe(true);
    await app.close();
  });
});

describe("audited mutation atomicity", () => {
  test("does not persist a token hash when token creation audit fails", async () => {
    const store = new FailingAuditStore();
    const { app, cookie } = await context(store);
    const auditCount = store.auditEvents.length;
    store.failAudit = true;

    const response = await app.inject({
      method: "POST", url: "/api/mcp/tokens", headers: { cookie }, payload: { name: "CI" }
    });

    expect(response.statusCode).toBe(500);
    expect(store.mcpTokens).toEqual([]);
    expect(store.auditEvents).toHaveLength(auditCount);
    await app.close();
  });

  test("does not revoke a token when revocation audit fails", async () => {
    const store = new FailingAuditStore();
    const { app, cookie, workspaceId } = await context(store);
    const token = await store.createMcpToken({
      workspaceId, name: "CI", tokenHash: "c".repeat(64), tokenPrefix: "dkh_example"
    });
    const auditCount = store.auditEvents.length;
    store.failAudit = true;

    const response = await app.inject({
      method: "POST", url: `/api/mcp/tokens/${token.id}/revoke`, headers: { cookie }
    });

    expect(response.statusCode).toBe(500);
    expect(store.mcpTokens[0].revokedAt).toBeNull();
    expect(store.auditEvents).toHaveLength(auditCount);
    await app.close();
  });

  test("does not persist reported feedback when its audit fails", async () => {
    const store = new FailingAuditStore();
    const { app, workspaceId } = await context(store);
    const auditCount = store.auditEvents.length;
    store.failAudit = true;
    const factory = createMcpServer as unknown as (value: {
      store: MemoryAppStore; workspaceId: string;
    }) => ReturnType<typeof createMcpServer>;
    const server = factory({ store, workspaceId });
    const client = new Client({ name: "audit-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "dkh_report_gap", arguments: { query: "deploy", reason: "missing" }
    });

    expect(response.isError).toBe(true);
    expect(store.feedback).toEqual([]);
    expect(store.auditEvents).toHaveLength(auditCount);
    await client.close();
    await server.close();
    await app.close();
  });

  test("rolls back a feedback transition and maps audit failure as server failure", async () => {
    const store = new FailingAuditStore();
    const { app, cookie, workspaceId } = await context(store);
    const feedback = await store.createFeedback({ workspaceId, query: "deploy", reason: "missing" });
    const auditCount = store.auditEvents.length;
    store.failAudit = true;

    const response = await app.inject({
      method: "PATCH", url: `/api/feedback/${feedback.id}`,
      headers: { cookie }, payload: { status: "acknowledged" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("FEEDBACK_OPERATION_FAILED");
    expect(store.feedback[0].status).toBe("open");
    expect(store.auditEvents).toHaveLength(auditCount);
    await app.close();
  });

  test("rolls back rebuild creation and association when its audit fails", async () => {
    const store = new FailingAuditStore();
    const { app, cookie, workspaceId, release } = await context(store);
    const feedback = await store.createFeedback({ workspaceId, query: "deploy", reason: "missing" });
    await store.transitionFeedback(workspaceId, feedback.id, "acknowledged");
    const buildCount = store.builds.length;
    const eventCount = store.buildEvents.length;
    const auditCount = store.auditEvents.length;
    store.failAudit = true;

    const response = await app.inject({
      method: "POST", url: `/api/feedback/${feedback.id}/rebuild`, headers: { cookie }
    });

    expect(response.statusCode).toBe(500);
    expect(store.builds).toHaveLength(buildCount);
    expect(store.buildEvents).toHaveLength(eventCount);
    expect(store.feedback.find((candidate) => candidate.id === feedback.id)?.rebuildBuildId).toBeNull();
    expect(store.auditEvents).toHaveLength(auditCount);
    expect(store.releases).toHaveLength(1);
    expect(store.releases[0].id).toBe(release.id);
    await app.close();
  });
});
