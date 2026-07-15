import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
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
  return { app, store, cookie: authenticatedCookie(login) };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("team projects and members", () => {
  test("isolates project activity and allows a reader to inspect it", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const workspace = await store.defaultWorkspace();
    const admin = await store.findAdminByEmail("admin@example.com");
    const first = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目甲", slug: "project-a" } });
    const second = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目乙", slug: "project-b" } });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    const firstRepo = await app.inject({ method: "POST", url: `/api/projects/${firstId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) }, payload: { kind: "upload", name: "甲资料" } });
    const secondRepo = await app.inject({ method: "POST", url: `/api/projects/${secondId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) }, payload: { kind: "upload", name: "乙资料" } });
    await store.recordAudit({ workspaceId: workspace!.id, actorId: admin!.id, action: "repository.sync_succeeded", resourceType: "repository", resourceId: firstRepo.json().repository.id });
    await store.recordAudit({ workspaceId: workspace!.id, actorId: admin!.id, action: "repository.sync_failed", resourceType: "repository", resourceId: secondRepo.json().repository.id });
    const reader = await app.inject({ method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) }, payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" } });
    await app.inject({
      method: "POST",
      url: `/api/projects/${firstId}/members`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: reader.json<{ member: { id: string } }>().member.id, role: "reader" }
    });
    const login = await app.inject({ method: "POST", url: "/api/session", payload: { email: "reader@example.com", password: "a secure reader password" } });
    const readerCookie = authenticatedCookie(login);

    const response = await app.inject({ method: "GET", url: `/api/projects/${firstId}/activity`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) } });

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

  test("keeps project activity permission-scoped and redacts unapproved audit metadata", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const workspace = await store.defaultWorkspace();
    const admin = await store.findAdminByEmail("admin@example.com");
    const first = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目甲", slug: "project-a" }
    });
    const second = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目乙", slug: "project-b" }
    });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    const reader = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const readerId = reader.json<{ member: { id: string } }>().member.id;
    await app.inject({
      method: "POST", url: `/api/projects/${firstId}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: readerId, role: "reader" }
    });
    await store.recordAudit({
      workspaceId: workspace!.id,
      actorId: admin!.id,
      action: "project.audit_checked",
      resourceType: "project",
      resourceId: firstId,
      metadata: { projectId: firstId, code: "SAFE", token: "dkh_should-not-leak", password: "should-not-leak" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = authenticatedCookie(login);

    const allowed = await app.inject({
      method: "GET", url: `/api/projects/${firstId}/activity`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }
    });
    const denied = await app.inject({
      method: "GET", url: `/api/projects/${secondId}/activity`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }
    });
    const memberWrite = await app.inject({
      method: "PATCH", url: `/api/projects/${firstId}/members/${readerId}`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) },
      payload: { role: "member" }
    });
    const adminRead = await app.inject({
      method: "GET", url: `/api/projects/${secondId}/activity`, headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "project.audit_checked",
        metadata: { code: "SAFE" }
      })
    ]));
    expect(allowed.body).not.toContain("dkh_should-not-leak");
    expect(allowed.body).not.toContain("should-not-leak");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });
    expect(memberWrite.statusCode).toBe(403);
    expect(memberWrite.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });
    expect(adminRead.statusCode).toBe(200);
  });

  test("initial setup provisions a default project for existing single-project workflows", async () => {
    const { app, cookie } = await authenticatedTeam();

    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });

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
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "控制台", slug: "console" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      project: { name: "控制台", slug: "console", archivedAt: null }
    });

    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ name: "控制台", slug: "console" })])
    });
  });

  test("returns a permission-scoped workspace overview with real indexed text totals", async () => {
    const { app, cookie } = await authenticatedTeam();

    const overview = await app.inject({ method: "GET", url: "/api/workspace/overview", headers: { cookie, ...csrfHeaders(cookie) } });

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
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;

    const reports = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/import-reports`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(reports.statusCode).toBe(200);
    expect(reports.json()).toMatchObject({ reports: [], total: 0, nextOffset: null });
  });

  test("returns a permission-scoped summary of the current project's latest snapshot changes", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;
    const repository = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) },
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
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const members = await app.inject({ method: "GET", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) } });
    const readerId = members.json<{ members: Array<{ id: string; email: string }> }>().members
      .find((member) => member.email === "reader@example.com")!.id;
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: readerId, role: "reader" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = authenticatedCookie(login);

    const changes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/changes`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }
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
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    const projectId = projects.json<{ projects: Array<{ id: string }> }>().projects[0].id;

    const quality = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/knowledge-quality`, headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(quality.statusCode).toBe(200);
    expect(quality.json()).toMatchObject({
      repository: null,
      latestSnapshot: null,
      currentRelease: null,
      knowledge: { pageCount: 0, chunkCount: 0, citationCount: 0 },
      remediation: { open: 0, accepted: 0, rebuilding: 0, resolved: 0, dismissed: 0 },
      diagnostics: [expect.objectContaining({ code: "SOURCE_MISSING" })]
    });
  });

  test("scopes remediation reads to project readers and transitions to project administrators", async () => {
    const { app, store, cookie } = await authenticatedTeam();
    const workspace = (await store.defaultWorkspace())!;
    const admin = (await store.findAdminByEmail("admin@example.com"))!;
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "质量项目", slug: "quality-project" }
    })).json<{ project: { id: string } }>().project;
    const repository = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/repositories`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "质量资料" }
    })).json<{ repository: { id: string } }>().repository;
    const sourceBuild = await store.createBuild({
      workspaceId: workspace.id, repositoryId: repository.id, snapshotId: "quality-snapshot",
      snapshotPath: "/tmp/quality-snapshot", commitSha: "a".repeat(40)
    });
    const remediation = await store.createRemediation({
      workspaceId: workspace.id, projectId: project.id, repositoryId: repository.id,
      sourceBuildId: sourceBuild.build.id,
      issue: {
        id: "lint-quality", buildId: sourceBuild.build.id, rule: "KNOWLEDGE_LOW_COVERAGE",
        severity: "warning", targetKind: "knowledge", targetId: "overview",
        message: "Knowledge coverage is low", sourceRefs: [], remediationState: "open"
      }
    });
    const reader = (await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "quality-reader@example.com", password: "a secure reader password", role: "reader" }
    })).json<{ member: { id: string } }>().member;
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: reader.id, role: "reader" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "quality-reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = authenticatedCookie(login);

    const visible = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/remediations`,
      headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({ remediations: [expect.objectContaining({ id: remediation.id, state: "open" })] });
    expect((await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/remediations/${remediation.id}`,
      headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }, payload: { state: "accepted" }
    })).statusCode).toBe(403);

    const accepted = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/remediations/${remediation.id}`,
      headers: { cookie, ...csrfHeaders(cookie) }, payload: { state: "accepted" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ remediation: { id: remediation.id, state: "accepted" } });
    expect((await app.inject({
      method: "POST", url: `/api/projects/${project.id}/remediations/${remediation.id}/rebuild`,
      headers: { cookie, ...csrfHeaders(cookie) }
    })).statusCode).toBe(503);
    const events = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/remediations/${remediation.id}/events`,
      headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) }
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ events: [expect.objectContaining({ fromState: "open", toState: "accepted", actorId: admin.id })] });
  });

  test("uses the requested project when resolving the current repository", async () => {
    const { app, cookie } = await authenticatedTeam();
    await app.inject({
      method: "POST", url: "/api/repositories", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "local", name: "默认来源", path: "/tmp/default-project" }
    });
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "移动端", slug: "mobile" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "移动端项目包" }
    });

    const current = await app.inject({
      method: "GET", url: "/api/repositories/current", headers: { cookie, ...csrfHeaders(cookie), "x-devkh-project": projectId }
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
      headers: { cookie, ...csrfHeaders(cookie) },
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
    const readerCookie = authenticatedCookie(readerLogin);
    const denied = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) },
      payload: { name: "不应创建" }
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  test("a read-only member cannot start a folder import", async () => {
    const { app, cookie } = await authenticatedTeam();
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "受限项目", slug: "restricted-project" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;
    await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "reader@example.com", password: "a secure reader password" }
    });
    const readerCookie = authenticatedCookie(login);

    const upload = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/folder-import`, headers: { cookie: readerCookie, ...csrfHeaders(readerCookie) },
      payload: {}
    });

    expect(upload.statusCode).toBe(403);
    expect(upload.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  test("an administrator attaches an independent upload source to a project", async () => {
    const { app, cookie } = await authenticatedTeam();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "移动端", slug: "mobile" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/repositories`,
      headers: { cookie, ...csrfHeaders(cookie) },
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
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "数据服务", slug: "data-service" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const token = await app.inject({
      method: "POST",
      url: "/api/mcp/tokens",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "数据服务 Codex", projectId }
    });

    expect(token.statusCode).toBe(201);
    expect(token.json()).toMatchObject({ projectId, name: "数据服务 Codex" });
  });

  test("lists only MCP tokens belonging to the requested project", async () => {
    const { app, cookie } = await authenticatedTeam();
    const first = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目一", slug: "project-one" }
    });
    const second = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目二", slug: "project-two" }
    });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    await app.inject({ method: "POST", url: "/api/mcp/tokens", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目一 Codex", projectId: firstId } });
    await app.inject({ method: "POST", url: "/api/mcp/tokens", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目二 Codex", projectId: secondId } });

    const listed = await app.inject({
      method: "GET", url: `/api/mcp/tokens?projectId=${firstId}`, headers: { cookie, ...csrfHeaders(cookie) }
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
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "支付服务", slug: "payments" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const pack = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/codex-connection`, headers: { cookie, ...csrfHeaders(cookie), host: "devkh.example.com" }
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
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "线上服务", slug: "online" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;

    const pack = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/codex-connection`, headers: { cookie, ...csrfHeaders(cookie), host: "127.0.0.1:3000" }
    });

    expect(pack.json()).toMatchObject({
      configToml: expect.stringContaining('url = "https://knowledge.example.com/mcp"')
    });
  });

  test("requires explicit project membership and lets a project administrator manage that project only", async () => {
    const { app, cookie } = await authenticatedTeam();
    const first = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目甲", slug: "project-a" }
    });
    const second = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "项目乙", slug: "project-b" }
    });
    const firstId = first.json<{ project: { id: string } }>().project.id;
    const secondId = second.json<{ project: { id: string } }>().project.id;
    await app.inject({ method: "POST", url: `/api/projects/${firstId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) }, payload: { kind: "upload", name: "甲资料" } });
    await app.inject({ method: "POST", url: `/api/projects/${secondId}/repositories`, headers: { cookie, ...csrfHeaders(cookie) }, payload: { kind: "upload", name: "乙资料" } });
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "member@example.com", password: "a secure member password", role: "member" }
    });
    const memberId = member.json<{ member: { id: string } }>().member.id;
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    });
    const memberCookie = authenticatedCookie(login);

    const denied = await app.inject({ method: "GET", url: `/api/projects/${firstId}/summary`, headers: { cookie: memberCookie, ...csrfHeaders(memberCookie) } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });

    await app.inject({
      method: "POST", url: `/api/projects/${firstId}/members`, headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId: memberId, role: "admin" }
    });
    const visible = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: memberCookie, ...csrfHeaders(memberCookie) } });
    expect(visible.json()).toMatchObject({ projects: [expect.objectContaining({ id: firstId })] });
    const projectRead = await app.inject({
      method: "GET", url: "/api/repositories/current", headers: { cookie: memberCookie, ...csrfHeaders(memberCookie), "x-devkh-project": firstId }
    });
    expect(projectRead.statusCode).toBe(200);
    const otherProject = await app.inject({ method: "GET", url: `/api/projects/${secondId}/summary`, headers: { cookie: memberCookie, ...csrfHeaders(memberCookie) } });
    expect(otherProject.statusCode).toBe(403);

    const reader = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "project-reader@example.com", password: "a secure reader password", role: "reader" }
    });
    const added = await app.inject({
      method: "POST", url: `/api/projects/${firstId}/members`, headers: { cookie: memberCookie, ...csrfHeaders(memberCookie) },
      payload: { userId: reader.json<{ member: { id: string } }>().member.id, role: "reader" }
    });
    expect(added.statusCode).toBe(201);
  });
});
