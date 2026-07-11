import { describe, expect, test } from "vitest";

import { buildServer, type ServerOptions } from "../app";
import { MemoryAppStore } from "../persistence/memory-store";
import { redactSensitive } from "./http";

function options(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    store: new MemoryAppStore(),
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    sessionSecret: "http-security-test-session-secret",
    dataDir: "/tmp/devkh-http-security",
    nodeEnv: "test",
    rateLimits: { setup: 1, login: 1, mcp: 1, feedback: 1, windowMs: 60_000 },
    ...overrides
  };
}

describe("HTTP security policy", () => {
  test("sets defensive headers and rejects JSON bodies over 1 MiB", async () => {
    const app = buildServer(options());

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.headers).toMatchObject({
      "content-security-policy": expect.stringContaining("default-src 'self'"),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer"
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "x".repeat(1_048_576) }
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
    await app.close();
  });

  test.each([
    ["setup", "/api/setup", { email: "invalid", password: "invalid" }],
    ["login", "/api/session", { email: "invalid", password: "invalid" }],
    ["mcp", "/mcp", {}],
    ["feedback", "/api/feedback/00000000-0000-4000-8000-000000000000/rebuild", {}]
  ])("rate limits %s writes independently", async (_name, url, payload) => {
    const app = buildServer(options());
    const first = await app.inject({ method: "POST", url, payload });
    const limited = await app.inject({ method: "POST", url, payload });

    expect(first.statusCode).not.toBe(429);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    await app.close();
  });

  test("redacts credentials recursively without changing safe metadata", () => {
    expect(redactSensitive({
      token: "mcp-secret",
      password: "admin-secret",
      providerApiKey: "provider-secret",
      authorization: "Bearer secret",
      nested: { encryptedApiKey: "ciphertext", model: "safe-model" }
    })).toEqual({
      token: "[REDACTED]",
      password: "[REDACTED]",
      providerApiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: { encryptedApiKey: "[REDACTED]", model: "safe-model" }
    });
  });
});
