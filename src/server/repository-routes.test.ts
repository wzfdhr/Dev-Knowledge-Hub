import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { decryptSecret } from "./security/crypto";

const apps: ReturnType<typeof buildServer>[] = [];

async function authenticatedApp() {
  const store = new MemoryAppStore();
  const masterKey = randomBytes(32).toString("base64");
  const app = buildServer({
    store,
    masterKey,
    sessionSecret: "repository-route-test-session-secret",
    dataDir: "/tmp/devkh-repository-tests",
    nodeEnv: "test"
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
  return { app, store, masterKey, cookie };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("repository routes", () => {
  test("treats a project without a repository as an empty onboarding state", async () => {
    const { app, cookie } = await authenticatedApp();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    const projectId = projects.json().projects[0].id as string;
    const headers = { cookie, ...csrfHeaders(cookie), "x-devkh-project": projectId };

    const [repository, status, builds, releases] = await Promise.all([
      app.inject({ method: "GET", url: "/api/repositories/current", headers }),
      app.inject({ method: "GET", url: "/api/repositories/current/status", headers }),
      app.inject({ method: "GET", url: "/api/builds?limit=20&offset=0", headers }),
      app.inject({ method: "GET", url: "/api/releases?limit=20&offset=0", headers })
    ]);

    expect(repository.statusCode).toBe(200);
    expect(repository.json()).toEqual({ repository: null });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ repository: null, latestSnapshot: null });
    expect(builds.statusCode).toBe(200);
    expect(builds.json()).toMatchObject({ builds: [], total: 0, nextOffset: null });
    expect(releases.statusCode).toBe(200);
    expect(releases.json()).toMatchObject({ releases: [], total: 0, nextOffset: null });

    const sync = await app.inject({
      method: "POST", url: "/api/repositories/current/sync", headers
    });
    expect(sync.statusCode).toBe(404);
    expect(sync.json()).toMatchObject({ error: { code: "REPOSITORY_NOT_FOUND" } });
  });

  test("returns a persisted project summary without fabricated defaults", async () => {
    const { app, cookie } = await authenticatedApp();
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie, ...csrfHeaders(cookie) } });
    const projectId = projects.json().projects[0].id as string;

    const empty = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/summary`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      project: { id: projectId },
      repository: null,
      latestSnapshot: null,
      currentRelease: null,
      latestBuild: null,
      memberCount: 1
    });

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/repositories`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "Uploaded project" }
    });
    const connected = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/summary`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      project: { id: projectId },
      repository: { projectId, kind: "upload", name: "Uploaded project" },
      latestSnapshot: null,
      currentRelease: null,
      latestBuild: null,
      memberCount: 1
    });
  });

  test("connects one local repository and returns sanitized current metadata", async () => {
    const { app, cookie } = await authenticatedApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "local", path: "/tmp/example-repository", name: "Example" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      repository: { kind: "local", path: "/tmp/example-repository", name: "Example" }
    });

    const current = await app.inject({
      method: "GET",
      url: "/api/repositories/current",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(created.json());

    const second = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "local", path: "/tmp/other", name: "Other" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "REPOSITORY_EXISTS" } });
  });

  test("encrypts a Git PAT and never returns or audits plaintext", async () => {
    const { app, store, masterKey, cookie } = await authenticatedApp();
    const token = ["github", "pat", "DO_NOT_EXPOSE_123456"].join("_");
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: {
        kind: "git",
        url: "https://github.com/example/private.git",
        name: "Private",
        token
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      repository: {
        kind: "git",
        url: "https://github.com/example/private.git",
        name: "Private",
        hasCredential: true
      }
    });
    expect(JSON.stringify(response.json())).not.toContain(token);
    expect(store.encryptedCredentials).toHaveLength(1);
    expect(store.encryptedCredentials[0].ciphertext).not.toContain(token);
    expect(decryptSecret(store.encryptedCredentials[0].ciphertext, masterKey)).toBe(token);
    expect(JSON.stringify(store.auditEvents)).not.toContain(token);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "git", url: "https://example.com/other.git", name: "Other", token }
    });
    expect(JSON.stringify(duplicate.json())).not.toContain(token);
  });

  test("rejects non-HTTPS Git remotes without echoing credentials", async () => {
    const { app, cookie } = await authenticatedApp();
    const token = ["github", "pat", "DO_NOT_EXPOSE_654321"].join("_");
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "git", url: "http://example.com/private.git", name: "Private", token }
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain(token);
  });

  test("replaces the current repository and exposes only sanitized archived history", async () => {
    const { app, cookie } = await authenticatedApp();
    await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "local", path: "/tmp/original", name: "Original" }
    });

    const replacement = await app.inject({
      method: "POST",
      url: "/api/repositories/current/replace",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "git", url: "https://github.com/example/replacement.git", name: "Replacement" }
    });

    expect(replacement.statusCode).toBe(201);
    expect(replacement.json()).toMatchObject({ repository: { name: "Replacement", kind: "git" } });
    const archived = await app.inject({
      method: "GET",
      url: "/api/repositories/archived",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ repositories: [{ name: "Original", kind: "local" }] });
    expect(JSON.stringify(archived.json())).not.toContain("/tmp/original");
  });

  test("prepares an uploaded replacement without changing the current repository", async () => {
    const { app, cookie } = await authenticatedApp();
    await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "local", path: "/tmp/original", name: "Original" }
    });

    const replacement = await app.inject({
      method: "POST",
      url: "/api/repositories/current/replace",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "Uploaded replacement" }
    });

    expect(replacement.statusCode).toBe(202);
    expect(replacement.json()).toMatchObject({
      repository: { kind: "upload", name: "Uploaded replacement" },
      pendingUpload: true
    });
    const current = await app.inject({
      method: "GET",
      url: "/api/repositories/current",
      headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(current.json()).toMatchObject({ repository: { name: "Original", kind: "local" } });
  });

  test("creates an upload repository without a filesystem path or credential", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "Uploaded project" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      repository: expect.objectContaining({ kind: "upload", name: "Uploaded project", defaultBranch: "upload" })
    });
  });

  test("asks upload repositories to import a ZIP instead of attempting a Git synchronization", async () => {
    const { app, cookie } = await authenticatedApp();
    await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { kind: "upload", name: "Uploaded project" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/sync",
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "UPLOAD_IMPORT_REQUIRED" } });
  });
});
