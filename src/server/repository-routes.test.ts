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
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  return { app, store, masterKey, cookie };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("repository routes", () => {
  test("connects one local repository and returns sanitized current metadata", async () => {
    const { app, cookie } = await authenticatedApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie },
      payload: { kind: "local", path: "/tmp/example-repository", name: "Example" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      repository: { kind: "local", path: "/tmp/example-repository", name: "Example" }
    });

    const current = await app.inject({
      method: "GET",
      url: "/api/repositories/current",
      headers: { cookie }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(created.json());

    const second = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie },
      payload: { kind: "local", path: "/tmp/other", name: "Other" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "REPOSITORY_EXISTS" } });
  });

  test("encrypts a Git PAT and never returns or audits plaintext", async () => {
    const { app, store, masterKey, cookie } = await authenticatedApp();
    const token = "github_pat_DO_NOT_EXPOSE_123456";
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie },
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
      headers: { cookie },
      payload: { kind: "git", url: "https://example.com/other.git", name: "Other", token }
    });
    expect(JSON.stringify(duplicate.json())).not.toContain(token);
  });

  test("rejects non-HTTPS Git remotes without echoing credentials", async () => {
    const { app, cookie } = await authenticatedApp();
    const token = "github_pat_DO_NOT_EXPOSE_654321";
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie },
      payload: { kind: "git", url: "http://example.com/private.git", name: "Private", token }
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain(token);
  });
});
