import { describe, expect, test } from "vitest";

import { loadEnv } from "./env";

describe("loadEnv", () => {
  test("test mode can load defaults without production secrets", () => {
    expect(loadEnv({ mode: "test", env: {} })).toMatchObject({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      dataDir: "./data"
    });
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

  test("production mode rejects a master key that is not exactly 32 base64 bytes", () => {
    expect(() => loadEnv({
      mode: "production",
      env: {
        DATABASE_URL: "postgres://localhost/devkh",
        DEVKH_MASTER_KEY: Buffer.from("short").toString("base64"),
        DEVKH_SESSION_SECRET: "production-session-secret"
      }
    })).toThrow(/32 bytes/);
  });
});
