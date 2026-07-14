import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer, type ServerOptions } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";

function options(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    store: new MemoryAppStore(),
    masterKey: randomBytes(32).toString("base64"),
    sessionSecret: "test-session-secret-with-sufficient-entropy",
    dataDir: "/tmp/devkh-auth-tests",
    nodeEnv: "test",
    ...overrides
  };
}

function sessionCookie(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie");
  return String(value).split(";", 1)[0];
}

describe("setup and session routes", () => {
  const apps: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test("setup is allowed once and creates the default workspace and admin", async () => {
    const app = buildServer(options());
    apps.push(app);

    const before = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(before.json()).toEqual({ setupRequired: true });

    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "Admin@Example.com", password: "a secure admin password" }
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.json()).toMatchObject({
      workspace: { name: "Default Workspace", slug: "default" },
      admin: { email: "admin@example.com" }
    });
    expect(setup.json()).not.toHaveProperty("admin.passwordHash");

    const second = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "other@example.com", password: "another secure password" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "SETUP_COMPLETE" } });
  });

  test("login issues a protected eight-hour cookie and session can be cleared", async () => {
    const store = new MemoryAppStore();
    const app = buildServer(options({ store }));
    apps.push(app);
    await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });

    const failed = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "admin@example.com", password: "wrong password" }
    });
    expect(failed.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toContain("devkh_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=28800");
    expect(setCookie).not.toContain("Secure");

    const cookie = sessionCookie(login);
    const current = await app.inject({ method: "GET", url: "/api/session", headers: { cookie } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ authenticated: true, admin: { email: "admin@example.com" } });

    const logout = await app.inject({ method: "DELETE", url: "/api/session", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    expect(store.auditEvents.map(({ action }) => action)).toEqual([
      "setup.completed",
      "session.login_failed",
      "session.login_succeeded"
    ]);
  });

  test("production session cookies are secure", async () => {
    const app = buildServer(options({ nodeEnv: "production" }));
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
    expect(String(login.headers["set-cookie"])).toContain("Secure");
  });

  test("an administrator can disable an invited member and immediately revoke that member's session", async () => {
    const store = new MemoryAppStore();
    const app = buildServer(options({ store }));
    apps.push(app);
    await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const adminLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const adminCookie = sessionCookie(adminLogin);
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie: adminCookie },
      payload: { email: "member@example.com", password: "a secure member password", role: "member" }
    });
    const memberId = member.json<{ member: { id: string } }>().member.id;
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    });
    const memberCookie = sessionCookie(memberLogin);

    const disabled = await app.inject({
      method: "PATCH", url: `/api/members/${memberId}/disabled`, headers: { cookie: adminCookie },
      payload: { disabled: true }
    });

    expect(disabled.statusCode).toBe(200);
    expect(await app.inject({ method: "GET", url: "/api/session", headers: { cookie: memberCookie } }))
      .toMatchObject({ statusCode: 401 });
    expect(await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    })).toMatchObject({ statusCode: 401 });
    expect(store.auditEvents.map((event) => event.action)).toContain("member.disabled");
  });

  test("repository routes reject unauthenticated requests", async () => {
    const app = buildServer(options());
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      payload: { kind: "local", path: "/tmp/repository", name: "Private repository" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});
