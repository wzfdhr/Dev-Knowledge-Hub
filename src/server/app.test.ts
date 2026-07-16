import { describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { hashPassword } from "./security/password";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";

function testServer() {
  return buildServer({
    store: new MemoryAppStore(),
    masterKey: Buffer.alloc(32, 1).toString("base64"),
    sessionSecret: "health-test-session-secret",
    dataDir: "/tmp/devkh-health-test",
    nodeEnv: "test"
  });
}

describe("buildServer", () => {
  test("GET /api/health returns service health payload", async () => {
    const app = testServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "dev-knowledge-hub"
    });

    await app.close();
  });

  test("serves the client entrypoint for direct application routes", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>console entrypoint</main>");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "spa-route-test-session-secret",
      dataDir: "/tmp/devkh-spa-test",
      nodeEnv: "production",
      clientDir
    });

    const response = await app.inject({ method: "GET", url: "/knowledge" });

    expect(response.statusCode).toBe(200);
    const policy = response.headers["content-security-policy"];
    const nonce = policy?.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(response.body).toContain(`content="${nonce}"`);
    expect(response.body).not.toContain("<!-- devkh:csp-nonce -->");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("console entrypoint");

    const laterResponse = await app.inject({ method: "GET", url: "/projects" });
    const laterNonce = laterResponse.headers["content-security-policy"]
      ?.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
    expect(laterNonce).toBeDefined();
    expect(laterNonce).not.toBe(nonce);
    await app.close();
  });

  test("keeps built client assets on the static file route", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await mkdir(path.join(clientDir, "assets"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>console entrypoint</main>");
    await writeFile(path.join(clientDir, "assets", "app.css"), "body { color: red; }");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "spa-assets-test-session-secret",
      dataDir: "/tmp/devkh-spa-assets-test",
      nodeEnv: "production",
      clientDir
    });

    const response = await app.inject({ method: "GET", url: "/assets/app.css" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("body { color: red; }");
    expect(response.headers["content-type"]).toContain("text/css");
    expect(response.headers["cache-control"]).not.toBe("no-store");
    await app.close();
  });

  test("serves React and retires the isolated Vue console route", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>react console</main>");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "vue-spa-route-test-session-secret",
      dataDir: path.join(clientDir, "data"),
      nodeEnv: "test",
      clientDir
    });

    const vueResponse = await app.inject({ method: "GET", url: "/console-vue/health" });
    const reactResponse = await app.inject({ method: "GET", url: "/projects" });

    expect(vueResponse.statusCode).toBe(404);
    expect(vueResponse.body).not.toContain("react console");
    expect(reactResponse.statusCode).toBe(200);
    expect(reactResponse.body).toContain("react console");
    await app.close();
  });

  test("rotates an MCP token only for the owning project administrator", async () => {
    const store = new MemoryAppStore();
    const password = "correct horse battery staple";
    const setup = await store.createInitialSetup("admin@example.com", await hashPassword(password));
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const previous = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      name: "Codex",
      tokenHash: "old-hash",
      tokenPrefix: "dkh_old"
    });
    const secret = "rotation-test-session-secret";
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: secret,
      dataDir: "/tmp/devkh-rotation-test",
      nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password }
    });
    const cookie = authenticatedCookie(login);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/tokens/${previous.id}/rotate`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      previous: { id: previous.id, revokedAt: expect.any(String) },
      replacement: { projectId: project.id, name: "Codex", revokedAt: null },
      token: expect.stringMatching(/^dkh_/)
    });
    expect(await store.findActiveMcpToken("old-hash")).toBeNull();
    await app.close();
  });

  test("rejects MCP token rotation by a project member without revoking the token", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const password = "correct horse battery staple";
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: await hashPassword(password), role: "member"
    }, setup!.admin.id);
    await store.addProjectMember(setup!.workspace.id, project.id, member!.id, "member", setup!.admin.id);
    const token = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      name: "Codex",
      tokenHash: "active-hash",
      tokenPrefix: "dkh_active"
    });
    const secret = "rotation-member-test-session-secret";
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: secret,
      dataDir: "/tmp/devkh-rotation-member-test",
      nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "member@example.com", password }
    });
    const cookie = authenticatedCookie(login);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/tokens/${token.id}/rotate`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });
    expect(await store.findActiveMcpToken("active-hash")).toMatchObject({ id: token.id });
    await app.close();
  });
});
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
