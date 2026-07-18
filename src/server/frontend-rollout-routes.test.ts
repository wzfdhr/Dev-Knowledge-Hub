import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";

const apps: ReturnType<typeof buildServer>[] = [];

async function fixture() {
  const store = new MemoryAppStore();
  const app = buildServer({
    store,
    masterKey: randomBytes(32).toString("base64"),
    sessionSecret: "frontend-rollout-route-test-secret",
    dataDir: "/tmp/devkh-frontend-rollout-tests",
    nodeEnv: "test",
    knowledgeKernelMode: "shadow",
    frontendKnowledgeMode: "shadow"
  });
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
  const cookie = authenticatedCookie(login);
  const projectResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie, ...csrfHeaders(cookie) },
    payload: { name: "Frontend", slug: "frontend" }
  });
  return {
    app,
    store,
    cookie,
    projectId: projectResponse.json<{ project: { id: string } }>().project.id
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("project frontend rollout routes", () => {
  test("defaults a project to legacy and records an administrator change", async () => {
    const { app, store, cookie, projectId } = await fixture();

    const initial = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/frontend-rollout`, headers: { cookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      kernelMode: "shadow", systemMode: "shadow", projectMode: null, effectiveMode: "legacy"
    });

    const changed = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/frontend-rollout`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { mode: "shadow", reason: "Validate the frontend-v2 shadow artifacts" }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ projectMode: "shadow", effectiveMode: "shadow" });
    expect(store.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "frontend_rollout.changed",
        metadata: expect.objectContaining({
          projectId, fromMode: "legacy", toMode: "shadow",
          reason: "Validate the frontend-v2 shadow artifacts"
        })
      })
    ]));
  });

  test("rejects a project mode above the configured system cap", async () => {
    const { app, cookie, projectId } = await fixture();
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/frontend-rollout`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { mode: "active", reason: "Attempt to bypass the rollout cap" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "FRONTEND_MODE_NOT_ALLOWED" } });
  });

  test("allows project readers to inspect rollout but only workspace admins to modify it", async () => {
    const { app, cookie, projectId } = await fixture();
    const memberResponse = await app.inject({
      method: "POST",
      url: "/api/members",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { email: "project-admin@example.com", password: "a secure member password", role: "member" }
    });
    const userId = memberResponse.json<{ member: { id: string } }>().member.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/members`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { userId, role: "admin" }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "project-admin@example.com", password: "a secure member password" }
    });
    const projectAdminCookie = authenticatedCookie(login);

    expect((await app.inject({
      method: "GET", url: `/api/projects/${projectId}/frontend-rollout`,
      headers: { cookie: projectAdminCookie }
    })).statusCode).toBe(200);
    const denied = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/frontend-rollout`,
      headers: { cookie: projectAdminCookie, ...csrfHeaders(projectAdminCookie) },
      payload: { mode: "shadow", reason: "Project admins cannot change the system rollout" }
    });
    expect(denied.statusCode).toBe(403);
  });
});
