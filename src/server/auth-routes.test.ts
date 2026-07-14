import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer, type ServerOptions } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { hashPassword } from "./security/password";
import { createSessionToken } from "./security/session";
import { generateTotp } from "./security/mfa";

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

function cookie(response: { headers: Record<string, string | string[] | number | undefined> }, name: string): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((candidate) => typeof candidate === "string" && candidate.startsWith(`${name}=`));
  if (!value) throw new Error(`Expected ${name} cookie`);
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

    const session = sessionCookie(login);
    const csrf = cookie(login, "devkh_csrf");
    const cookieHeader = `${session}; ${csrf}`;
    const current = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: cookieHeader } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ authenticated: true, admin: { email: "admin@example.com" } });

    const logout = await app.inject({
      method: "DELETE", url: "/api/session",
      headers: { cookie: cookieHeader, "x-devkh-csrf": csrf.split("=", 2)[1] }
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    expect(store.auditEvents.map(({ action }) => action)).toEqual([
      "setup.completed",
      "session.login_failed",
      "session.login_succeeded"
    ]);
  });

  test("requires a double-submit CSRF token for cookie-authenticated writes and revokes logout sessions", async () => {
    const app = buildServer(options());
    apps.push(app);
    await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const session = cookie(login, "devkh_session");
    const csrf = cookie(login, "devkh_csrf");

    expect(session.split("=", 2)[1]).not.toContain(".");
    expect(csrf).toContain(".");
    expect((await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: `${session}; ${csrf}` },
      payload: { name: "Missing CSRF", slug: "missing-csrf" }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: "/api/projects", headers: {
        cookie: `${session}; ${csrf}`, "x-devkh-csrf": "invalid"
      }, payload: { name: "Wrong CSRF", slug: "wrong-csrf" }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: "/api/projects", headers: {
        cookie: `${session}; ${csrf}`, "x-devkh-csrf": csrf.split("=", 2)[1]
      }, payload: { name: "CSRF protected", slug: "csrf-protected" }
    })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/session", headers: { cookie: `${session}; ${csrf}` } })).statusCode)
      .toBe(200);

    expect((await app.inject({
      method: "DELETE", url: "/api/session", headers: {
        cookie: `${session}; ${csrf}`, "x-devkh-csrf": csrf.split("=", 2)[1]
      }
    })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/session", headers: { cookie: `${session}; ${csrf}` } })).statusCode)
      .toBe(401);
  });

  test("allows an unexpired legacy cookie to read during the configured rollout window but never write", async () => {
    const store = new MemoryAppStore();
    const secret = "test-session-secret-with-sufficient-entropy";
    const setup = await store.createInitialSetup(
      "admin@example.com", await hashPassword("a secure admin password")
    );
    const legacySession = await createSessionToken({
      adminId: setup!.admin.id,
      workspaceId: setup!.workspace.id,
      sessionVersion: setup!.admin.sessionVersion
    }, secret);
    const app = buildServer(options({
      store,
      sessionSecret: secret,
      legacySessionReadUntil: new Date(Date.now() + 60_000)
    }));
    apps.push(app);
    const cookie = `devkh_session=${legacySession}`;

    expect((await app.inject({ method: "GET", url: "/api/session", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Legacy write", slug: "legacy-write" }
    })).statusCode).toBe(401);
    const expiredWindowApp = buildServer(options({
      store,
      sessionSecret: secret,
      legacySessionReadUntil: new Date(Date.now() - 1)
    }));
    apps.push(expiredWindowApp);
    expect((await expiredWindowApp.inject({ method: "GET", url: "/api/session", headers: { cookie } })).statusCode)
      .toBe(401);
  });

  test("does not accept a browser session cookie as MCP bearer authentication", async () => {
    const app = buildServer(options());
    apps.push(app);
    await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });

    expect((await app.inject({ method: "POST", url: "/mcp", headers: { cookie: sessionCookie(login) } })).statusCode)
      .toBe(401);
  });

  test("enrolls and verifies administrator MFA before requiring it at login", async () => {
    const store = new MemoryAppStore();
    const app = buildServer(options({ store }));
    apps.push(app);
    await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const login = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    });
    const session = sessionCookie(login);
    const csrf = cookie(login, "devkh_csrf");
    const cookieHeader = `${session}; ${csrf}`;
    const enrolled = await app.inject({
      method: "POST", url: "/api/settings/mfa/enroll",
      headers: { cookie: cookieHeader, "x-devkh-csrf": csrf.split("=", 2)[1] },
      payload: { currentPassword: "a secure admin password" }
    });

    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json()).toMatchObject({ enabled: false, secret: expect.any(String), otpauthUri: expect.stringMatching(/^otpauth:\/\//) });
    expect(store.adminMfa[0]?.encryptedSecret).not.toContain(enrolled.json<{ secret: string }>().secret);
    const verified = await app.inject({
      method: "POST", url: "/api/settings/mfa/verify",
      headers: { cookie: cookieHeader, "x-devkh-csrf": csrf.split("=", 2)[1] },
      payload: { code: generateTotp(enrolled.json().secret) }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().recoveryCodes).toHaveLength(10);
    const recoveryCode = verified.json<{ recoveryCodes: string[] }>().recoveryCodes[0];
    expect((await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password", recoveryCode }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password", recoveryCode }
    })).statusCode).toBe(401);

    expect((await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "admin@example.com", password: "a secure admin password" }
    })).json()).toMatchObject({ error: { code: "MFA_REQUIRED" } });
  });

  test("locks repeated MFA failures and revokes existing sessions when MFA is disabled", async () => {
    const app = buildServer(options());
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "a secure admin password" } });
    const initialLogin = await app.inject({ method: "POST", url: "/api/session", payload: { email: "admin@example.com", password: "a secure admin password" } });
    const session = sessionCookie(initialLogin);
    const csrf = cookie(initialLogin, "devkh_csrf");
    const cookieHeader = `${session}; ${csrf}`;
    const enrolled = await app.inject({
      method: "POST", url: "/api/settings/mfa/enroll", headers: { cookie: cookieHeader, "x-devkh-csrf": csrf.split("=", 2)[1] },
      payload: { currentPassword: "a secure admin password" }
    });
    const verified = await app.inject({
      method: "POST", url: "/api/settings/mfa/verify", headers: { cookie: cookieHeader, "x-devkh-csrf": csrf.split("=", 2)[1] },
      payload: { code: generateTotp(enrolled.json().secret) }
    });
    expect(verified.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/api/session",
        payload: { email: "admin@example.com", password: "a secure admin password", code: "000000" }
      });
      expect(response.statusCode).toBe(attempt === 4 ? 429 : 401);
    }

    const appForDisable = buildServer(options());
    apps.push(appForDisable);
    await appForDisable.inject({ method: "POST", url: "/api/setup", payload: { email: "disable@example.com", password: "a secure admin password" } });
    const disableSetupLogin = await appForDisable.inject({ method: "POST", url: "/api/session", payload: { email: "disable@example.com", password: "a secure admin password" } });
    const disableSetupSession = sessionCookie(disableSetupLogin);
    const disableSetupCsrf = cookie(disableSetupLogin, "devkh_csrf");
    const disableEnrollment = await appForDisable.inject({
      method: "POST", url: "/api/settings/mfa/enroll",
      headers: { cookie: `${disableSetupSession}; ${disableSetupCsrf}`, "x-devkh-csrf": disableSetupCsrf.split("=", 2)[1] },
      payload: { currentPassword: "a secure admin password" }
    });
    await appForDisable.inject({
      method: "POST", url: "/api/settings/mfa/verify",
      headers: { cookie: `${disableSetupSession}; ${disableSetupCsrf}`, "x-devkh-csrf": disableSetupCsrf.split("=", 2)[1] },
      payload: { code: generateTotp(disableEnrollment.json<{ secret: string }>().secret) }
    });
    const activeMfaSession = await appForDisable.inject({
      method: "POST", url: "/api/session",
      payload: {
        email: "disable@example.com",
        password: "a secure admin password",
        code: generateTotp(disableEnrollment.json<{ secret: string }>().secret)
      }
    });
    const activeSession = sessionCookie(activeMfaSession);
    const activeCsrf = cookie(activeMfaSession, "devkh_csrf");
    const disabled = await appForDisable.inject({
      method: "DELETE", url: "/api/settings/mfa",
      headers: { cookie: `${activeSession}; ${activeCsrf}`, "x-devkh-csrf": activeCsrf.split("=", 2)[1] },
      payload: {
        currentPassword: "a secure admin password",
        code: generateTotp(disableEnrollment.json<{ secret: string }>().secret)
      }
    });
    expect(disabled.statusCode).toBe(204);
    expect((await appForDisable.inject({ method: "GET", url: "/api/session", headers: { cookie: activeSession } })).statusCode).toBe(401);
    expect((await appForDisable.inject({
      method: "POST", url: "/api/session",
      payload: { email: "disable@example.com", password: "a secure admin password" }
    })).statusCode).toBe(200);
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
    const adminSession = sessionCookie(adminLogin);
    const adminCsrf = cookie(adminLogin, "devkh_csrf");
    const adminCookie = `${adminSession}; ${adminCsrf}`;
    const member = await app.inject({
      method: "POST", url: "/api/members", headers: { cookie: adminCookie, "x-devkh-csrf": adminCsrf.split("=", 2)[1] },
      payload: { email: "member@example.com", password: "a secure member password", role: "member" }
    });
    const memberId = member.json<{ member: { id: string } }>().member.id;
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    });
    const memberCookie = sessionCookie(memberLogin);

    const disabled = await app.inject({
      method: "PATCH", url: `/api/members/${memberId}/disabled`, headers: { cookie: adminCookie, "x-devkh-csrf": adminCsrf.split("=", 2)[1] },
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
