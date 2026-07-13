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
});
