import { describe, expect, test, vi } from "vitest";
import path from "node:path";

import { bootstrapProductionServer, type BootstrapDependencies } from "./bootstrap";

function dependencies(): BootstrapDependencies {
  const pool = { durable: true, end: vi.fn(async () => {}) };
  const store = {
    durable: true,
    deleteExpiredImportReports: vi.fn(async () => 0),
    listActiveGitRepositories: vi.fn(async () => [])
  };
  const queue = { durable: true };
  const buildService = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const server = { durable: true, addHook: vi.fn() };
  return {
    createDatabase: vi.fn(() => ({ pool } as never)),
    runMigrations: vi.fn(async () => []),
    createStore: vi.fn(() => store as never),
    createBuildQueue: vi.fn(() => queue as never),
    createBuildService: vi.fn(() => buildService as never),
    buildServer: vi.fn(() => server as never),
    createUploadStagingCleaner: vi.fn(() => ({ cleanupExpired: vi.fn(async () => ({ sessions: 0, completed: 0 })) })),
    setInterval: vi.fn(() => ({})),
    clearInterval: vi.fn(() => {}),
    reportBackgroundError: vi.fn(() => {})
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
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DATA_DIR: "/var/lib/devkh"
    }, deps);

    const database = vi.mocked(deps.createDatabase).mock.results[0].value;
    const store = vi.mocked(deps.createStore).mock.results[0].value;
    const queue = vi.mocked(deps.createBuildQueue).mock.results[0].value;
    const buildService = vi.mocked(deps.createBuildService).mock.results[0].value;
    expect(deps.createDatabase).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(deps.runMigrations).toHaveBeenCalledWith(database.pool);
    expect(deps.createStore).toHaveBeenCalledWith(database.pool);
    expect(deps.createBuildQueue).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(deps.createBuildService).toHaveBeenCalledWith(store, queue, expect.any(Function));
    expect(buildService.start).toHaveBeenCalledOnce();
    expect(deps.buildServer).toHaveBeenCalledWith({
      store,
      buildService,
      masterKey,
      sessionSecret: "production-session-secret-at-least-32-chars",
      dataDir: "/var/lib/devkh",
      nodeEnv: "production",
      clientDir: path.resolve("dist/client")
    });
    expect(server.addHook).toHaveBeenCalledWith("onClose", expect.any(Function));
    expect(server).toBe(vi.mocked(deps.buildServer).mock.results[0].value);
  });

  test("stops the build queue before closing the database", async () => {
    const order: string[] = [];
    const deps = dependencies();
    vi.mocked(deps.createBuildService).mockImplementation(() => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { order.push("queue"); })
    } as never));
    vi.mocked(deps.createDatabase).mockReturnValue({
      pool: { end: vi.fn(async () => { order.push("database"); }) }
    } as never);
    const server = await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
    }, deps);
    const onClose = vi.mocked(server.addHook).mock.calls.find(([name]) => name === "onClose")?.[1];

    await (onClose as () => Promise<void>)();

    expect(order).toEqual(["queue", "database"]);
  });

  test("cleans upload staging at startup, schedules hourly retries, and clears the timer on shutdown", async () => {
    const deps = dependencies();
    const cleaner = { cleanupExpired: vi.fn(async () => ({ sessions: 0, completed: 0 })) };
    const interval = { id: "upload-cleanup" };
    deps.createUploadStagingCleaner = vi.fn(() => cleaner);
    deps.setInterval = vi.fn(() => interval);
    deps.clearInterval = vi.fn();
    deps.reportBackgroundError = vi.fn();

    const server = await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DATA_DIR: "/var/lib/devkh"
    }, deps);
    const store = vi.mocked(deps.createStore).mock.results[0].value;
    await vi.waitFor(() => expect(cleaner.cleanupExpired).toHaveBeenCalledOnce());
    expect(store.deleteExpiredImportReports).toHaveBeenCalledWith(expect.any(Date));
    expect(store.listActiveGitRepositories).toHaveBeenCalledOnce();
    expect(deps.createUploadStagingCleaner).toHaveBeenCalledWith("/var/lib/devkh/upload-staging");
    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);

    const onClose = vi.mocked(server.addHook).mock.calls.find(([name]) => name === "onClose")?.[1];
    await (onClose as () => Promise<void>)();

    expect(deps.clearInterval).toHaveBeenCalledWith(interval);
    expect(deps.reportBackgroundError).not.toHaveBeenCalled();
  });

  test("reports a staging cleanup failure without rejecting production startup", async () => {
    const deps = dependencies();
    const error = new Error("staging unavailable");
    deps.createUploadStagingCleaner = vi.fn(() => ({ cleanupExpired: vi.fn(async () => { throw error; }) }));

    await expect(bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
    }, deps)).resolves.toBeDefined();
    await vi.waitFor(() => expect(deps.reportBackgroundError).toHaveBeenCalledWith(
      "Upload staging cleanup failed",
      error
    ));
  });
});
