import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer, type ServerOptions } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";

const apps: ReturnType<typeof buildServer>[] = [];

async function authenticatedTeam(overrides: { publicBaseUrl?: string } = {}) {
  const store = new MemoryAppStore();
  const app = buildServer({
    store,
    masterKey: randomBytes(32).toString("base64"),
    sessionSecret: "team-route-test-session-secret",
    dataDir: "/tmp/devkh-team-tests",
    nodeEnv: "test",
    ...overrides
  } as ServerOptions);
  apps.push(app);
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  return { app, store, cookie: String(login.headers["set-cookie"]).split(";", 1)[0] };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("team projects and members", () => {
  test("isolates project activity and allows a reader to inspect it", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const workspace = await store.defaultWorkspace();
    const admin = await store.findAdminByEmail("admin@example.com");
    const first = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目甲", slug: "project-a" } });
    const second = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目乙", slug: "project-b" } });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    const firstRepo = await app.inject({ method: "POST", url: `/api/projects/${firstId}/repositories`, headers: { cookie }, payload: { kind: "upload", name: "甲资料" } });
    const secondRepo = await app.inject({ method: "POST", url: `/api/projects/${secondId}/repositories`, headers: { cookie }, payload: { kind: "upload", name: "乙资料" } });
    await store.recordAudit({ workspaceId: workspace!.id, actorId: admin!.id, action: "repository.sync_succeeded", resourceType: "repository", resourceId: firstRepo.json().repository.id });
    await store.recordAudit({ workspaceId: workspace!.id, actorId: admin!.id, action: "repository.sync_failed", resourceType: "repository", resourceId: secondRepo.json().repository.id });
    const reader = await app.inject({ method: "POST", url: "/api/members", headers: { cookie }, payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" } });
    await app.inject({
      method: "POST",
      url: `/api/projects/${firstId}/members`,
      headers: { cookie },
      payload: { userId: reader.json<{ member: { id: string } }>().member.id, role: "reader" }
    });
    const login = await app.inject({ method: "POST", url: "/api/session", payload: { email: "reader@example.com", password: "a secure reader password" } });
    const readerCookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    const response = await app.inject({ method: "GET", url: `/api/projects/${firstId}/activity`, headers: { cookie: readerCookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "repository.sync_succeeded", projectId: firstId, actorEmail: "admin@example.com" })
    ]));
    expect(response.json().activity).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "repository.sync_failed" })
    ]));
    expect(response.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "reader@example.com", role: "reader" })
    ]));
  });

  test("initial setup provisions a default project for existing single-project workflows", async () => {
    const { app, cookie } = await authenticatedTeam();

    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });

    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual({
      projects: [expect.objectContaining({ name: "默认项目", slug: "default-project", archivedAt: null })]
    });
  });

  test("an administrator creates a project and sees it in the team project center", async () => {
    const { app, cookie } = await authenticatedTeam();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "控制台", slug: "console" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      project: { name: "控制台", slug: "console", archivedAt: null }
    });

    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ name: "控制台", slug: "console" })])
    });
  });

  test("returns a permission-scoped workspace overview with real indexed text totals", async () => {
    const { app, cookie } = await authenticatedTeam();

    const overview = await app.inject({ method: "GET", url: "/api/workspace/overview", headers: { cookie } });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      projects: [expect.objectContaining({
        repository: null,
        latestSnapshot: null,
        indexedTextBytes: 0,
        pendingFeedbackCount: 0
      })]
    });
  });

  test("lists the server-side import history for an accessible project", async () => {
    const { app, cookie } = await authenticatedTeam();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;

    const reports = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/import-reports`,
      headers: { cookie }
    });

    expect(reports.statusCode).toBe(200);
    expect(reports.json()).toMatchObject({ reports: [], total: 0, nextOffset: null });
  });

  test("returns a permission-scoped summary of the current project's latest snapshot changes", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;
    const repository = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/repositories`, headers: { cookie },
      payload: { kind: "upload", name: "团队资料" }
    });
    const repositoryId = repository.json<{ repository: { id: string } }>().repository.id;
    const workspace = await store.defaultWorkspace();
    await store.createSnapshot({
      snapshot: {
        id: "change-first", workspaceId: workspace!.id, repositoryId, commitSha: "a".repeat(40),
        ref: "first", remoteUrl: null, commitTimestamp: new Date("2026-01-01T00:00:00.000Z"), storagePath: "/tmp/first"
      },
      files: [
        { id: "first-kept", workspaceId: workspace!.id, snapshotId: "change-first", path: "src/kept.ts", byteSize: 3, contentHash: "one", language: "typescript" },
        { id: "first-deleted", workspaceId: workspace!.id, snapshotId: "change-first", path: "src/deleted.ts", byteSize: 3, contentHash: "old", language: "typescript" }
      ]
    });
    await store.createSnapshot({
      snapshot: {
        id: "change-second", workspaceId: workspace!.id, repositoryId, commitSha: "b".repeat(40),
        ref: "second", remoteUrl: null, commitTimestamp: new Date("2026-01-02T00:00:00.000Z"), storagePath: "/tmp/second"
      },
      files: [
        { id: "second-kept", workspaceId: workspace!.id, snapshotId: "change-second", path: "src/kept.ts", byteSize: 3, contentHash: "two", language: "typescript" },
        { id: "second-added", workspaceId: workspace!.id, snapshotId: "change-second", path: "src/added.ts", byteSize: 3, contentHash: "new", language: "typescript" }
      ]
    });
    await app.inject({
      method: "POST", url: "/api/members", headers: { cookie },
      payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const members = await app.inject({ method: "GET", url: "/api/members", headers: { cookie } });
    const readerId = members.json<{ members: Array<{ id: string; email: string }> }>().members
      .find((member) => member.email === "reader@example.com")!.id;
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie },
      payload: { userId: readerId, role: "reader" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    const changes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/changes`, headers: { cookie: readerCookie }
    });

    expect(changes.statusCode).toBe(200);
    expect(changes.json()).toEqual({
      change: expect.objectContaining({
        snapshotId: "change-second", previousSnapshotId: "change-first",
        added: ["src/added.ts"], modified: ["src/kept.ts"], deleted: ["src/deleted.ts"], requiresBuild: true
      })
    });
  });

  test("reports a source-free project as an onboarding quality state instead of an API failure", async () => {
    const { app, cookie } = await authenticatedTeam();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;

    const quality = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/knowledge-quality`, headers: { cookie }
    });

    expect(quality.statusCode).toBe(200);
    expect(quality.json()).toMatchObject({
      repository: null,
      latestSnapshot: null,
      currentRelease: null,
      knowledge: { pageCount: 0, chunkCount: 0, citationCount: 0 },
      diagnostics: [expect.objectContaining({ code: "SOURCE_MISSING" })]
    });
  });

  test("uses the requested project when resolving the current repository", async () => {
    const { app, cookie } = await authenticatedTeam();
    await app.inject({
      method: "POST", url: "/api/repositories", headers: { cookie },
      payload: { kind: "local", name: "默认来源", path: "/tmp/default-project" }
    });
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "移动端", slug: "mobile" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/repositories`, headers: { cookie },
      payload: { kind: "upload", name: "移动端项目包" }
    });

    const current = await app.inject({
      method: "GET", url: "/api/repositories/current", headers: { cookie, "x-devkh-project": projectId }
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      repository: { projectId, kind: "upload", name: "移动端项目包" }
    });
  });

  test("an administrator can add a read-only member but that member cannot administer projects", async () => {
    const { app, cookie } = await authenticatedTeam();
    const added = await app.inject({
      method: "POST",
      url: "/api/members",
      headers: { cookie },
      payload: {
        email: "reader@example.com",
        password: "a secure reader password",
        role: "reader"
      }
    });

    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ member: { email: "reader@example.com", role: "reader" } });

    const readerLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = String(readerLogin.headers["set-cookie"]).split(";", 1)[0];
    const denied = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: readerCookie },
      payload: { name: "不应创建" }
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  test("a read-only member cannot start an upload session", async () => {
    const { app, cookie } = await authenticatedTeam();
    await app.inject({
      method: "POST", url: "/api/members", headers: { cookie },
      payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    const upload = await app.inject({
      method: "POST", url: "/api/uploads/resumable", headers: { cookie: readerCookie },
      payload: { totalBytes: 8, chunkSize: 4 }
    });

    expect(upload.statusCode).toBe(403);
    expect(upload.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  test("an administrator attaches an independent upload source to a project", async () => {
    const { app, cookie } = await authenticatedTeam();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "移动端", slug: "mobile" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/repositories`,
      headers: { cookie },
      payload: { kind: "upload", name: "移动端项目包" }
    });

    expect(attached.statusCode).toBe(201);
    expect(attached.json()).toMatchObject({
      repository: { projectId, kind: "upload", name: "移动端项目包" }
    });
  });

  test("an MCP token is scoped to the project selected at creation", async () => {
    const { app, cookie } = await authenticatedTeam();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "数据服务", slug: "data-service" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const token = await app.inject({
      method: "POST",
      url: "/api/mcp/tokens",
      headers: { cookie },
      payload: { name: "数据服务 Codex", projectId }
    });

    expect(token.statusCode).toBe(201);
    expect(token.json()).toMatchObject({ projectId, name: "数据服务 Codex" });
  });

  test("lists only MCP tokens belonging to the requested project", async () => {
    const { app, cookie } = await authenticatedTeam();
    const first = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目一", slug: "project-one" }
    });
    const second = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目二", slug: "project-two" }
    });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    await app.inject({ method: "POST", url: "/api/mcp/tokens", headers: { cookie }, payload: { name: "项目一 Codex", projectId: firstId } });
    await app.inject({ method: "POST", url: "/api/mcp/tokens", headers: { cookie }, payload: { name: "项目二 Codex", projectId: secondId } });

    const listed = await app.inject({
      method: "GET", url: `/api/mcp/tokens?projectId=${firstId}`, headers: { cookie }
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      tokens: [{ projectId: firstId, name: "项目一 Codex" }],
      total: 1,
      nextOffset: null
    });
  });

  test("an administrator can retrieve a project-specific Codex connection pack", async () => {
    const { app, cookie } = await authenticatedTeam();
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "支付服务", slug: "payments" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const pack = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/codex-connection`, headers: { cookie, host: "devkh.example.com" }
    });

    expect(pack.statusCode).toBe(200);
    expect(pack.json()).toMatchObject({
      projectId,
      environmentVariable: "DEVKH_PAYMENTS_TOKEN",
      configToml: expect.stringContaining('url = "http://devkh.example.com/mcp"'),
      agentsMarkdown: expect.stringContaining("支付服务")
    });
  });

  test("uses the configured public HTTPS origin in a Codex connection pack", async () => {
    const { app, cookie } = await authenticatedTeam({ publicBaseUrl: "https://knowledge.example.com/" });
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "线上服务", slug: "online" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const pack = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/codex-connection`, headers: { cookie, host: "127.0.0.1:3000" }
    });

    expect(pack.json()).toMatchObject({
      configToml: expect.stringContaining('url = "https://knowledge.example.com/mcp"')
    });
  });

  test("requires explicit project membership and lets a project administrator manage that project only", async () => {
    const { app, cookie } = await authenticatedTeam();
    const first = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目甲", slug: "project-a" }
    });
    const second = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "项目乙", slug: "project-b" }
    });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    await app.inject({ method: "POST", url: `/api/projects/${firstId}/repositories`, headers: { cookie }, payload: { kind: "upload", name: "甲资料" } });
    await app.inject({ method: "POST", url: `/api/projects/${secondId}/repositories`, headers: { cookie }, payload: { kind: "upload", name: "乙资料" } });
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie },
      payload: { email: "member@example.com", password: "a secure member password", role: "member" }
    });
    const memberId = member.json<{ member: { id: string } }>().member.id;
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    });
    const memberCookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    const denied = await app.inject({ method: "GET", url: `/api/projects/${firstId}/summary`, headers: { cookie: memberCookie } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });

    await app.inject({
      method: "POST", url: `/api/projects/${firstId}/members`, headers: { cookie },
      payload: { userId: memberId, role: "admin" }
    });
    const visible = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: memberCookie } });
    expect(visible.json()).toMatchObject({ projects: [expect.objectContaining({ id: firstId })] });
    const projectRead = await app.inject({
      method: "GET", url: "/api/repositories/current", headers: { cookie: memberCookie, "x-devkh-project": firstId }
    });
    expect(projectRead.statusCode).toBe(200);
    const otherProject = await app.inject({ method: "GET", url: `/api/projects/${secondId}/summary`, headers: { cookie: memberCookie } });
    expect(otherProject.statusCode).toBe(403);

    const reader = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie },
      payload: { email: "project-reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const added = await app.inject({
      method: "POST", url: `/api/projects/${firstId}/members`, headers: { cookie: memberCookie },
      payload: { userId: reader.json<{ member: { id: string } }>().member.id, role: "reader" }
    });
    expect(added.statusCode).toBe(201);
  });
});
