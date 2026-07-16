import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";

const apps: ReturnType<typeof buildServer>[] = [];

describe("pipeline build routes", () => {
  test("keeps the legacy build status when a shadow stage fails", async () => {
    const store = new MemoryAppStore();
    const app = buildServer({
      store,
      masterKey: randomBytes(32).toString("base64"),
      sessionSecret: "pipeline-routes-session-secret",
      dataDir: "/tmp/devkh-pipeline-routes",
      nodeEnv: "test"
    });
    apps.push(app);
    const setup = await app.inject({
      method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const workspaceId = setup.json().workspace.id as string;
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const cookie = authenticatedCookie(login);
    const projectId = (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } })).json().projects[0].id as string;
    const headers = { cookie, ...csrfHeaders(cookie), "x-devkh-project": projectId };
    const created = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/repositories`, headers, payload: { kind: "upload", name: "Source" }
    });
    const repositoryId = created.json().repository.id as string;
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: randomUUID(), workspaceId, repositoryId, commitSha: "a".repeat(40), ref: "main",
        remoteUrl: null, commitTimestamp: new Date(), storagePath: "/tmp/devkh-pipeline-routes-snapshot"
      },
      files: []
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId, snapshotId: snapshot.id, snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    await store.transitionBuild(build.id, "queued", "ready");
    const run = await store.createStageRun({
      workspaceId, projectId, snapshotId: snapshot.id, buildId: build.id,
      stage: "convert", attempt: 1, inputDigest: "b".repeat(64)
    });
    await store.transitionStageRun(workspaceId, projectId, run.id, "queued", "running");
    await store.transitionStageRun(workspaceId, projectId, run.id, "running", "failed", {
      errorCode: "PIPELINE_STAGE_FAILED", errorDetail: "shadow conversion failed"
    });

    const response = await app.inject({ method: "GET", url: `/api/builds/${build.id}/stages`, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ legacyStatus: "ready", pipelineStatus: "failed" });

    const queued = await store.createStageRun({
      workspaceId, projectId, snapshotId: snapshot.id, buildId: build.id,
      stage: "extract", attempt: 1, inputDigest: "c".repeat(64)
    });
    await store.cancelPipelineStageRuns(workspaceId, projectId, build.id);

    expect((await store.listPipelineStageRuns(workspaceId, projectId, build.id))
      .find((candidate) => candidate.id === queued.id)).toMatchObject({ status: "cancelled" });
  });

  test("reserves build comparison for workspace administrators", async () => {
    const store = new MemoryAppStore();
    const app = buildServer({
      store,
      masterKey: randomBytes(32).toString("base64"),
      sessionSecret: "pipeline-comparison-session-secret",
      dataDir: "/tmp/devkh-pipeline-comparison",
      nodeEnv: "test"
    });
    apps.push(app);
    await app.inject({
      method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const adminCookie = authenticatedCookie(login);
    const unavailable = await app.inject({
      method: "GET", url: `/api/builds/${randomUUID()}/comparison`, headers: { cookie: adminCookie }
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: "PIPELINE_COMPARISON_UNAVAILABLE" } });

    const createMember = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie: adminCookie, ...csrfHeaders(adminCookie) },
      payload: { email: "reader@example.com", password: "another secure password", role: "reader" }
    });
    expect(createMember.statusCode).toBe(201);
    const readerLogin = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "reader@example.com", password: "another secure password" }
    });
    const response = await app.inject({
      method: "GET", url: `/api/builds/${randomUUID()}/comparison`, headers: { cookie: authenticatedCookie(readerLogin) }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
