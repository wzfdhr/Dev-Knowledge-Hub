import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import { decryptSecret } from "./security/crypto";

const apps: ReturnType<typeof buildServer>[] = [];

async function context() {
  const store = new MemoryAppStore();
  const masterKey = Buffer.alloc(32, 19).toString("base64");
  const app = buildServer({
    store,
    masterKey,
    sessionSecret: "model-settings-session-secret",
    dataDir: "/tmp/devkh-model-settings",
    nodeEnv: "test"
  });
  apps.push(app);
  await app.inject({
    method: "POST", url: "/api/setup",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const login = await app.inject({
    method: "POST", url: "/api/session",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  return {
    app, store, masterKey,
    cookie: authenticatedCookie(login)
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("model settings", () => {
  test("stores the API key encrypted and returns only sanitized metadata", async () => {
    const { app, store, masterKey, cookie } = await context();
    const plaintext = "sk-model-key-never-returned";

    const saved = await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "openai", model: "gpt-5-mini", apiKey: plaintext }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      config: { provider: "openai", model: "gpt-5-mini", hasApiKey: true }
    });
    expect(JSON.stringify(saved.json())).not.toContain(plaintext);
    expect(store.encryptedCredentials).toHaveLength(1);
    expect(store.encryptedCredentials[0]).toMatchObject({
      repositoryId: null,
      name: "model-provider",
      metadata: { provider: "openai", model: "gpt-5-mini" }
    });
    expect(store.encryptedCredentials[0].ciphertext).not.toContain(plaintext);
    expect(decryptSecret(store.encryptedCredentials[0].ciphertext, masterKey)).toBe(plaintext);

    const fetched = await app.inject({
      method: "GET", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(fetched.json()).toEqual(saved.json());
    expect(JSON.stringify(fetched.json())).not.toContain(plaintext);
  });

  test("blank API key preserves the existing encrypted secret", async () => {
    const { app, store, cookie } = await context();
    await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "openai", model: "gpt-5-mini", apiKey: "existing-secret" }
    });
    const ciphertext = store.encryptedCredentials[0].ciphertext;

    const updated = await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "" }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      config: { provider: "anthropic", model: "claude-sonnet-4-5", hasApiKey: true }
    });
    expect(store.encryptedCredentials[0].ciphertext).toBe(ciphertext);
  });

  test("stores the DeepSeek credential separately from an existing generic provider credential", async () => {
    const { app, store, masterKey, cookie } = await context();
    const genericKey = "generic-key-that-must-remain-isolated";
    const deepseekKey = "deepseek-key-that-must-remain-isolated";
    await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "openai", model: "gpt-5-mini", apiKey: genericKey }
    });
    const genericCiphertext = store.encryptedCredentials[0].ciphertext;

    const saved = await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: deepseekKey }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      config: { provider: "deepseek", model: "deepseek-v4-flash", hasApiKey: true }
    });
    expect(store.encryptedCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "model-provider", ciphertext: genericCiphertext }),
      expect.objectContaining({ name: "model-provider-deepseek" })
    ]));
    expect(store.encryptedCredentials).toHaveLength(2);
    const deepseekCredential = store.encryptedCredentials.find(({ name }) => name === "model-provider-deepseek");
    expect(deepseekCredential).toBeDefined();
    expect(decryptSecret(deepseekCredential!.ciphertext, masterKey)).toBe(deepseekKey);
    expect(JSON.stringify(saved.json())).not.toContain(deepseekKey);
  });

  test("ignores a client-selected DeepSeek model and saves the internal default", async () => {
    const { app, store, cookie } = await context();

    const saved = await app.inject({
      method: "PUT", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { provider: "deepseek", model: "untrusted-model-name", apiKey: "deepseek-key" }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      config: { provider: "deepseek", model: "deepseek-v4-flash", hasApiKey: true }
    });
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: "model_config.updated",
      metadata: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
  });

  test("reports an unconfigured model without creating fake state", async () => {
    const { app, cookie } = await context();
    const response = await app.inject({
      method: "GET", url: "/api/settings/model", headers: { cookie, ...csrfHeaders(cookie) }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ config: null });
  });
});
