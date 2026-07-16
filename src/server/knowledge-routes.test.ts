import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { buildServer } from "./app";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service";
import { generateKnowledge } from "./knowledge/generator";
import { analyzeSnapshot } from "./knowledge/intelligence";
import { MemoryAppStore } from "./persistence/memory-store";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/code-intelligence"
);

class TestQueue implements BuildJobQueue {
  sent: string[] = [];
  async send(buildId: string) { this.sent.push(buildId); }
  async start() {}
  async stop() {}
}

async function authenticatedApp() {
  const store = new MemoryAppStore();
  const buildService = new BuildService(store, new TestQueue());
  const app = buildServer({
    store,
    buildService,
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    sessionSecret: "knowledge-route-session-secret",
    dataDir: "/tmp/devkh-knowledge-route",
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
  const cookie = authenticatedCookie(login);
  const connected = await app.inject({
    method: "POST", url: "/api/repositories", headers: { cookie, ...csrfHeaders(cookie) },
    payload: { kind: "local", name: "Fixture", path: fixtureRoot }
  });
  const repositoryId = connected.json().repository.id as string;
  const workspaceId = (await store.defaultWorkspace())!.id;
  const index = await analyzeSnapshot(fixtureRoot, "1".repeat(40));
  await store.createSnapshot({
    snapshot: {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId,
      repositoryId,
      commitSha: index.commitSha,
      ref: "main",
      remoteUrl: null,
      commitTimestamp: new Date("2026-07-11T00:00:00Z"),
      storagePath: fixtureRoot
    },
    files: index.files.map((file, position) => ({
      id: `00000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`,
      workspaceId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      path: file.path,
      byteSize: 1,
      contentHash: file.blobHash,
      language: null
    }))
  });
  return { app, store, buildService, cookie, repositoryId, workspaceId, index };
}

describe("knowledge API contracts", () => {
  test("lets a workspace administrator roll current back to a published legacy release with an audit trail", async () => {
    const { app, store, cookie, repositoryId, workspaceId } = await authenticatedApp();
    const createReadyBuild = async (commitSha: string) => {
      const build = (await store.createBuild({
        workspaceId,
        repositoryId,
        snapshotId: "11111111-1111-4111-8111-111111111111",
        snapshotPath: fixtureRoot,
        commitSha
      })).build;
      await store.transitionBuild(build.id, "queued", "ready");
      return build;
    };
    const firstBuild = await createReadyBuild("a".repeat(40));
    const first = await store.createReleaseDraft(workspaceId, repositoryId, firstBuild.id, "1.0.0");
    await store.publishRelease(workspaceId, first.id);
    const secondBuild = await createReadyBuild("b".repeat(40));
    const second = await store.createReleaseDraft(workspaceId, repositoryId, secondBuild.id, "2.0.0");
    await store.publishRelease(workspaceId, second.id);
    const repository = await store.getRepository(workspaceId, repositoryId);
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "project-admin@example.com", password: "correct horse battery staple", role: "member" }
    });
    const projectAdminId = member.json().member.id as string;
    await app.inject({
      method: "POST", url: `/api/projects/${repository!.projectId}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: projectAdminId, role: "admin" }
    });
    const projectAdminLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "project-admin@example.com", password: "correct horse battery staple" }
    });
    const projectAdminCookie = authenticatedCookie(projectAdminLogin);
    const denied = await app.inject({
      method: "POST", url: `/api/releases/${first.id}/rollback`,
      headers: { cookie: projectAdminCookie, ...csrfHeaders(projectAdminCookie) }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const originalRecordAudit = store.recordAudit.bind(store);
    store.recordAudit = async (event) => {
      if (event.action === "release.rolled_back") throw new Error("audit connection failed");
      await originalRecordAudit(event);
    };
    const failed = await app.inject({
      method: "POST", url: `/api/releases/${first.id}/rollback`, headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: "ROLLBACK_FAILED", message: "Rollback could not be completed" } });
    expect(failed.body).not.toContain("audit connection failed");
    expect((await store.currentRelease(workspaceId, repositoryId))?.id).toBe(second.id);

    store.recordAudit = originalRecordAudit;
    const response = await app.inject({
      method: "POST", url: `/api/releases/${first.id}/rollback`, headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ release: { id: first.id }, previousReleaseId: second.id });
    expect((await store.currentRelease(workspaceId, repositoryId))?.id).toBe(first.id);
    expect(store.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "release.rolled_back", resourceType: "release", resourceId: first.id,
        metadata: expect.objectContaining({ previousReleaseId: second.id })
      })
    ]));
    await app.close();
  });

  test("starts, lists, reads, cancels, and streams build state", async () => {
    const { app, cookie } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    expect(started.statusCode).toBe(202);
    const buildId = started.json().build.id as string;

    expect((await app.inject({ method: "GET", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) } })).json().builds)
      .toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/builds/${buildId}`, headers: { cookie, ...csrfHeaders(cookie) } })).statusCode)
      .toBe(200);
    expect((await app.inject({
      method: "POST", url: `/api/builds/${buildId}/cancel`, headers: { cookie, ...csrfHeaders(cookie) }
    })).json().build.cancelRequested).toBe(true);
    const events = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/events?once=true`, headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: build");
    expect(events.body).toContain("\"status\":\"queued\"");
    await app.close();
  });

  test("allows only project administrators to opt in to LLM builds and records the decision", async () => {
    const { app, store, cookie, repositoryId, workspaceId } = await authenticatedApp();
    const repository = await store.getRepository(workspaceId, repositoryId);
    expect(repository).not.toBeNull();
    const projectId = repository!.projectId;
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "member@example.com", password: "correct horse battery staple", role: "member" }
    });
    expect(member.statusCode).toBe(201);
    const memberId = member.json().member.id as string;
    const added = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: memberId, role: "member" }
    });
    expect(added.statusCode).toBe(201);
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "correct horse battery staple" }
    });
    const memberCookie = authenticatedCookie(memberLogin);
    const headers = { "x-devkh-project": projectId };

    const denied = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie: memberCookie, ...csrfHeaders(memberCookie), ...headers },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111", allowLlm: true }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("PROJECT_ACCESS_DENIED");

    const accepted = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie), ...headers },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111", allowLlm: true }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().build.allowLlm).toBe(true);
    const activity = await store.listProjectActivity(workspaceId, projectId);
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "build.llm_opted_in",
        resourceType: "build",
        resourceId: accepted.json().build.id,
        metadata: expect.objectContaining({ projectId, snapshotId: "11111111-1111-4111-8111-111111111111" })
      })
    ]));
    await app.close();
  });

  test("does not create an opted-in LLM build when its audit record cannot be written", async () => {
    const { app, store, cookie, repositoryId, workspaceId } = await authenticatedApp();
    const repository = await store.getRepository(workspaceId, repositoryId);
    expect(repository).not.toBeNull();
    const originalRecordAudit = store.recordAudit.bind(store);
    store.recordAudit = vi.fn(async (event) => {
      if (event.action === "build.llm_opted_in") throw new Error("audit unavailable");
      await originalRecordAudit(event);
    });

    const response = await app.inject({
      method: "POST", url: "/api/builds", headers: {
        cookie, ...csrfHeaders(cookie), "x-devkh-project": repository!.projectId
      },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111", allowLlm: true }
    });

    expect(response.statusCode).toBe(500);
    expect(await store.listBuilds(workspaceId, repositoryId)).toEqual([]);
    await app.close();
  });

  test("subscribes before replay and merges a racing live event exactly once", async () => {
    const { app, store, buildService, cookie } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    const buildId = started.json().build.id as string;
    const queued = (await store.listBuildEvents((await store.defaultWorkspace())!.id, buildId))[0];
    let listener: ((event: typeof queued) => void) | null = null;
    buildService.subscribe = ((_id: string, candidate: (event: typeof queued) => void) => {
      listener = candidate;
      return () => { listener = null; };
    }) as typeof buildService.subscribe;
    store.listBuildEvents = (async () => {
      listener?.({ ...queued, sequence: queued.sequence + 1, status: "syncing" });
      return [queued];
    }) as typeof store.listBuildEvents;

    const response = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/events?once=true`, headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.body.match(/^id: 1$/gm)).toHaveLength(1);
    expect(response.body.match(/^id: 2$/gm)).toHaveLength(1);
    expect(response.body.indexOf("id: 1")).toBeLessThan(response.body.indexOf("id: 2"));
    await app.close();
  });

  test("closes immediately when replay already contains a terminal event", async () => {
    const { app, store, buildService, cookie, workspaceId } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    const buildId = started.json().build.id as string;
    const queued = (await store.listBuildEvents(workspaceId, buildId))[0];
    store.listBuildEvents = (async () => [
      queued,
      { ...queued, sequence: queued.sequence + 1, status: "ready" as const }
    ]) as typeof store.listBuildEvents;
    buildService.subscribe = (() => () => {}) as typeof buildService.subscribe;

    const response = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/events`, headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("\"status\":\"ready\"");
    expect(response.body).toContain("id: 2");
    await app.close();
  });

  test("returns persisted stage snapshots and reconnectable stage events for the build project", async () => {
    const { app, store, cookie, repositoryId, workspaceId } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    const buildId = started.json().build.id as string;
    const repository = await store.getRepository(workspaceId, repositoryId);
    const stage = await store.createStageRun({
      workspaceId,
      projectId: repository!.projectId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      buildId,
      stage: "convert",
      attempt: 1,
      inputDigest: "a".repeat(64)
    });
    await store.transitionStageRun(
      workspaceId,
      repository!.projectId,
      stage.id,
      "queued",
      "running"
    );

    const stages = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/stages`, headers: { cookie }
    });
    expect(stages.statusCode).toBe(200);
    expect(stages.json()).toMatchObject({
      buildId,
      stages: [expect.objectContaining({ stage: "convert", status: "running" })]
    });

    const events = await app.inject({
      method: "GET",
      url: `/api/builds/${buildId}/stages/events?once=true`,
      headers: { cookie, "last-event-id": "1" }
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).not.toContain("id: 1");
    expect(events.body).toContain("id: 2");
    expect(events.body).toContain("event: stage.updated");
    await app.close();
  });

  test("rejects invalid stage cursors and users without access to the build project", async () => {
    const { app, store, cookie, repositoryId, workspaceId } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    const buildId = started.json().build.id as string;
    const repository = await store.getRepository(workspaceId, repositoryId);
    await store.createStageRun({
      workspaceId, projectId: repository!.projectId, snapshotId: "11111111-1111-4111-8111-111111111111",
      buildId, stage: "convert", attempt: 1, inputDigest: "a".repeat(64)
    });
    const invalidCursor = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/stages/events?once=true`,
      headers: { cookie, "last-event-id": "not-a-cursor" }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().error.code).toBe("INVALID_EVENT_CURSOR");

    const created = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "reader@example.com", password: "another correct horse battery", role: "reader" }
    });
    expect(created.statusCode).toBe(201);
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "another correct horse battery" }
    });
    const denied = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/stages`, headers: { cookie: authenticatedCookie(memberLogin) }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("PROJECT_ACCESS_DENIED");
    await app.close();
  });

  test("drafts and manually publishes a release, then serves pages, search, and source", async () => {
    const { app, store, cookie, repositoryId, workspaceId, index } = await authenticatedApp();
    const build = (await store.createBuild({
      workspaceId,
      repositoryId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      snapshotPath: fixtureRoot,
      commitSha: index.commitSha
    })).build;
    await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
    await store.transitionBuild(build.id, "queued", "ready");

    const draft = await app.inject({
      method: "POST", url: "/api/releases", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { buildId: build.id, version: "1.0.0" }
    });
    expect(draft.statusCode).toBe(201);
    expect((await app.inject({
      method: "GET", url: "/api/releases/current", headers: { cookie, ...csrfHeaders(cookie) }
    })).statusCode).toBe(404);
    const releaseId = draft.json().release.id as string;
    const exactRelease = await app.inject({
      method: "GET", url: `/api/releases/${releaseId}`, headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(exactRelease.statusCode).toBe(200);
    expect(exactRelease.json().release).toMatchObject({ id: releaseId, commitSha: index.commitSha });
    const missingRelease = await app.inject({
      method: "GET",
      url: "/api/releases/99999999-9999-4999-8999-999999999999",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(missingRelease.statusCode).toBe(404);
    expect(missingRelease.json().error).toEqual({
      code: "RELEASE_NOT_FOUND",
      message: "Release was not found"
    });
    expect((await app.inject({
      method: "POST", url: `/api/releases/${releaseId}/publish`, headers: { cookie, ...csrfHeaders(cookie) }
    })).statusCode).toBe(200);

    const pages = await app.inject({ method: "GET", url: "/api/knowledge/pages", headers: { cookie, ...csrfHeaders(cookie) } });
    expect(pages.json().pages.length).toBeGreaterThan(4);
    const pageId = pages.json().pages[0].id as string;
    expect((await app.inject({
      method: "GET", url: `/api/knowledge/pages/${encodeURIComponent(pageId)}`, headers: { cookie, ...csrfHeaders(cookie) }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET", url: "/api/knowledge/search?q=add", headers: { cookie, ...csrfHeaders(cookie) }
    })).json().results[0].kind).toBe("symbol");
    const source = await app.inject({
      method: "GET",
      url: "/api/knowledge/source?path=src/math.ts&startLine=16&endLine=18",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(source.json()).toEqual(expect.objectContaining({
      path: "src/math.ts", startLine: 16, endLine: 18
    }));
    expect(source.json().content).toContain("export function add");
    expect((await app.inject({ method: "GET", url: "/api/releases", headers: { cookie, ...csrfHeaders(cookie) } })).json().releases)
      .toHaveLength(1);
    const status = await app.inject({
      method: "GET", url: "/api/repositories/current/status", headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(status.json().latestSnapshot).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      commitSha: index.commitSha,
      ref: "main"
    });
    const releaseList = await app.inject({ method: "GET", url: "/api/releases", headers: { cookie, ...csrfHeaders(cookie) } });
    expect(releaseList.json().releases[0].commitSha).toBe(index.commitSha);
    const metadata = await app.inject({
      method: "GET", url: `/api/knowledge/metadata?releaseId=${releaseId}`, headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(metadata.json().symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "add", kind: "function", path: "src/math.ts" })
    ]));
    expect(metadata.json().dependencies).toEqual(expect.any(Array));
    await app.close();
  });

  test("rejects a malformed exact release ID before querying the store", async () => {
    const { app, store, cookie } = await authenticatedApp();
    const getRelease = vi.spyOn(store, "getRelease");

    const response = await app.inject({
      method: "GET",
      url: "/api/releases/not-a-uuid",
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({
      code: "INVALID_INPUT",
      message: "Invalid release ID"
    });
    expect(getRelease).not.toHaveBeenCalled();
    await app.close();
  });

  test("accepts a 500-line source request and rejects 501 lines during validation", async () => {
    const { app, store, cookie, repositoryId, workspaceId, index } = await authenticatedApp();
    const build = (await store.createBuild({
      workspaceId,
      repositoryId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      snapshotPath: fixtureRoot,
      commitSha: index.commitSha
    })).build;
    await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
    await store.transitionBuild(build.id, "queued", "ready");
    const release = await store.createReleaseDraft(workspaceId, repositoryId, build.id, "1.0.0");
    await store.publishRelease(workspaceId, release.id);

    const fiveHundred = await app.inject({
      method: "GET",
      url: "/api/knowledge/source?path=src/math.ts&startLine=1&endLine=500",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    const fiveHundredOne = await app.inject({
      method: "GET",
      url: "/api/knowledge/source?path=src/math.ts&startLine=1&endLine=501",
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(fiveHundred.json().error.code).toBe("INVALID_SOURCE_RANGE");
    expect(fiveHundredOne.json().error.code).toBe("INVALID_REQUEST");
    await app.close();
  });
});
