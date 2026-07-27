import { describe, expect, test } from "vitest";

import { buildServer, type ServerOptions } from "../app";
import { MemoryAppStore } from "../persistence/memory-store";
import { RateLimitState, UploadBodyConcurrencyState, redactSensitive } from "./http";

function options(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    store: new MemoryAppStore(),
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    sessionSecret: "http-security-test-session-secret",
    dataDir: "/tmp/devkh-http-security",
    nodeEnv: "test",
    rateLimits: {
      setup: 1,
      login: 1,
      mcp: 1,
      feedback: 1,
      upload: 1,
      uploadOperation: 1,
      windowMs: 60_000,
      maxEntries: 100,
      sweepIntervalMs: 60_000
    },
    ...overrides
  };
}

describe("HTTP security policy", () => {
  test("allows authenticated large uploads up to the ten-minute request budget", async () => {
    const app = buildServer(options());
    expect((app.initialConfig as { requestTimeout?: number }).requestTimeout).toBe(10 * 60_000);
    await app.close();
  });

  test("periodically removes expired rate-limit buckets", () => {
    const state = new RateLimitState({ maxEntries: 10, sweepIntervalMs: 100 });
    state.consume("setup:one", 1, 0, 50);
    state.consume("setup:two", 1, 10, 50);

    state.consume("setup:three", 1, 100, 50);

    expect(state.size).toBe(1);
    expect(state.has("setup:three")).toBe(true);
  });

  test("evicts the deterministic oldest bucket and remains hard bounded", () => {
    const state = new RateLimitState({ maxEntries: 3, sweepIntervalMs: 10_000 });
    state.consume("setup:b", 1, 0, 60_000);
    state.consume("setup:a", 1, 0, 60_000);
    state.consume("setup:c", 1, 1, 60_000);
    state.consume("setup:d", 1, 2, 60_000);
    expect(state.has("setup:b")).toBe(false);
    expect(state.has("setup:a")).toBe(true);
    for (let index = 0; index < 100; index += 1) {
      state.consume(`login:${index}`, 1, index + 3, 60_000);
    }

    expect(state.size).toBe(3);
  });

  test("bounds buffered upload bodies globally, per client, and per session", () => {
    const state = new UploadBodyConcurrencyState({ global: 2, client: 1, session: 1 });
    const first = state.acquire("client-a", "session-a");
    expect(first).toBeTypeOf("function");
    expect(state.acquire("client-a", "session-b")).toBeNull();
    const second = state.acquire("client-b", "session-b");
    expect(second).toBeTypeOf("function");
    expect(state.acquire("client-c", "session-c")).toBeNull();
    first!();
    expect(state.acquire("client-c", "session-a")).toBeTypeOf("function");
    second!();
  });

  test("allows two buffered bodies from the same upload session before applying protection", () => {
    const state = new UploadBodyConcurrencyState();
    const first = state.acquire("client-a", "session-a");
    const second = state.acquire("client-a", "session-a");

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(state.acquire("client-a", "session-a")).toBeNull();

    first!();
    second!();
  });

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
    ["upload", "/api/projects/00000000-0000-4000-8000-000000000000/upload-sessions", {
      repositoryId: "00000000-0000-4000-8000-000000000001", entryCount: 1
    }],
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

  test("rate limits durable upload operations separately from session creation", async () => {
    const app = buildServer(options());
    const url = "/api/projects/00000000-0000-4000-8000-000000000000/upload-sessions/00000000-0000-4000-8000-000000000001/files/0";
    const first = await app.inject({ method: "PUT", url, payload: Buffer.from("source") });
    const limited = await app.inject({ method: "PUT", url, payload: Buffer.from("source") });

    expect(first.statusCode).not.toBe(429);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    await app.close();
  });

  test("trusts exactly one reverse-proxy hop and ignores a client-supplied earlier hop", async () => {
    const app = buildServer(options());
    const url = "/api/session";
    const first = await app.inject({
      method: "POST", url, headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" }, payload: {}
    });
    const limited = await app.inject({
      method: "POST", url, headers: { "x-forwarded-for": "203.0.113.11, 10.0.0.2" }, payload: {}
    });

    expect(first.statusCode).not.toBe(429);
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  test.each([
    "/api/projects/00000000-0000-4000-8000-000000000000/folder-import",
    "/api/repositories/00000000-0000-4000-8000-000000000000/folder-import"
  ])("rate limits the compatibility folder upload route %s", async (url) => {
    const app = buildServer(options());
    const first = await app.inject({ method: "POST", url });
    const limited = await app.inject({ method: "POST", url });

    expect(first.statusCode).not.toBe(429);
    expect(limited.statusCode).toBe(429);
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
