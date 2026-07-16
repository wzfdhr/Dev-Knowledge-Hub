import { describe, expect, test } from "vitest";

import { loadEnv } from "./env";

describe("loadEnv", () => {
  test("test mode can load defaults without production secrets", () => {
    expect(loadEnv({ mode: "test", env: {} })).toMatchObject({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      dataDir: "./data",
      knowledgeKernelMode: "legacy"
    });
  });

  test("defaults to legacy and enables shadow only by explicit kernel mode", () => {
    expect(loadEnv({ mode: "development", env: {} }).knowledgeKernelMode).toBe("legacy");
    expect(loadEnv({
      mode: "development",
      env: { DEVKH_KNOWLEDGE_KERNEL_MODE: "shadow" }
    }).knowledgeKernelMode).toBe("shadow");
  });

  test("accepts only the documented knowledge kernel modes", () => {
    expect(loadEnv({
      mode: "development",
      env: { DEVKH_KNOWLEDGE_KERNEL_MODE: "active" }
    }).knowledgeKernelMode).toBe("active");
    expect(() => loadEnv({
      mode: "development",
      env: { DEVKH_KNOWLEDGE_KERNEL_MODE: "unexpected" }
    })).toThrow(/DEVKH_KNOWLEDGE_KERNEL_MODE/);
  });

  test("production mode rejects missing required secrets", () => {
    expect(() => loadEnv({ mode: "production", env: {} })).toThrow(/DATABASE_URL/);
  });

  test("development mode loads provided persistence and security settings", () => {
    expect(loadEnv({
      mode: "development",
      env: {
        DATABASE_URL: "postgres://localhost/devkh",
        DEVKH_MASTER_KEY: Buffer.alloc(32).toString("base64"),
        DEVKH_SESSION_SECRET: "development-session-secret"
      }
    })).toMatchObject({
      databaseUrl: "postgres://localhost/devkh",
      masterKey: Buffer.alloc(32).toString("base64"),
      sessionSecret: "development-session-secret"
    });
  });

  test("loads a bounded legacy session read window as a date", () => {
    expect(loadEnv({
      mode: "development",
      env: { DEVKH_LEGACY_SESSION_READ_UNTIL: "2026-07-15T00:00:00.000Z" }
    }).legacySessionReadUntil).toEqual(new Date("2026-07-15T00:00:00.000Z"));
  });

  test("rejects a legacy session window longer than 24 hours", () => {
    expect(() => loadEnv({
      mode: "development",
      env: { DEVKH_LEGACY_SESSION_READ_UNTIL: new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString() }
    })).toThrow(/24 hours/);
  });

  test("production mode rejects a master key that is not exactly 32 base64 bytes", () => {
    expect(() => loadEnv({
      mode: "production",
      env: {
        DATABASE_URL: "postgres://localhost/devkh",
        DEVKH_MASTER_KEY: Buffer.from("short").toString("base64"),
        DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
      }
    })).toThrow(/32 bytes/);
  });

  test("production mode rejects a short session secret", () => {
    expect(() => loadEnv({
      mode: "production",
      env: {
        DATABASE_URL: "postgres://localhost/devkh",
        DEVKH_MASTER_KEY: Buffer.alloc(32).toString("base64"),
        DEVKH_SESSION_SECRET: "short"
      }
    })).toThrow(/32 characters/);
  });
});
