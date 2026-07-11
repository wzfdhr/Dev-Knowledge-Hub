import { describe, expect, test, vi } from "vitest";

import { bootstrapProductionServer, type BootstrapDependencies } from "./bootstrap";

function dependencies(): BootstrapDependencies {
  const pool = { durable: true };
  const store = { durable: true };
  const server = { durable: true, addHook: vi.fn() };
  return {
    createDatabase: vi.fn(() => ({ pool } as never)),
    runMigrations: vi.fn(async () => []),
    createStore: vi.fn(() => store as never),
    buildServer: vi.fn(() => server as never)
  };
}

describe("production bootstrap", () => {
  test("rejects missing durable persistence and security environment", async () => {
    const deps = dependencies();

    await expect(bootstrapProductionServer({}, deps)).rejects.toThrow(/DATABASE_URL/);
    expect(deps.createDatabase).not.toHaveBeenCalled();
    expect(deps.buildServer).not.toHaveBeenCalled();
  });

  test("migrates and builds the server with the PostgreSQL store", async () => {
    const deps = dependencies();
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const server = await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: masterKey,
      DEVKH_SESSION_SECRET: "production-session-secret",
      DATA_DIR: "/var/lib/devkh"
    }, deps);

    const database = vi.mocked(deps.createDatabase).mock.results[0].value;
    const store = vi.mocked(deps.createStore).mock.results[0].value;
    expect(deps.createDatabase).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(deps.runMigrations).toHaveBeenCalledWith(database.pool);
    expect(deps.createStore).toHaveBeenCalledWith(database.pool);
    expect(deps.buildServer).toHaveBeenCalledWith({
      store,
      masterKey,
      sessionSecret: "production-session-secret",
      dataDir: "/var/lib/devkh",
      nodeEnv: "production"
    });
    expect(server).toBe(vi.mocked(deps.buildServer).mock.results[0].value);
  });
});
