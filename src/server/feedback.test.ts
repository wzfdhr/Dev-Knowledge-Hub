import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service";
import { generateKnowledge } from "./knowledge/generator";
import { analyzeSnapshot } from "./knowledge/intelligence";
import { MemoryAppStore } from "./persistence/memory-store";

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

async function context() {
  const store = new MemoryAppStore();
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
