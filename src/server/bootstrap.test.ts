import { describe, expect, test, vi } from "vitest";
import path from "node:path";

import { bootstrapProductionServer, type BootstrapDependencies } from "./bootstrap";
import type { BuildRecord } from "./knowledge/build-service";

function dependencies(): BootstrapDependencies {
  const pool = { durable: true, end: vi.fn(async () => {}) };
  const store = {
    durable: true,
    deleteExpiredImportReports: vi.fn(async () => 0),
    listActiveGitRepositories: vi.fn(async () => [])
  };
  const queue = { durable: true };
  const qualityWorker = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    schedule: vi.fn(async () => {})
  };
  const buildService = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const server = { durable: true, addHook: vi.fn() };
  return {
    createDatabase: vi.fn(() => ({ pool } as never)),
    runMigrations: vi.fn(async () => []),
    createStore: vi.fn(() => store as never),
    createBuildQueue: vi.fn(() => queue as never),
    createBuildService: vi.fn(() => buildService as never),
    createArtifactStore: vi.fn(() => ({ initialize: vi.fn(async () => {}) })),
    createQualityPipelineWorker: vi.fn(() => qualityWorker),
    buildServer: vi.fn(() => server as never),
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

  test("starts the staged quality worker only when the pipeline is explicitly enabled", async () => {
    const deps = dependencies();
    const artifactStore = { initialize: vi.fn(async () => {}) };
    (deps as BootstrapDependencies & { createArtifactStore: (directory: string) => typeof artifactStore }).createArtifactStore = vi.fn(() => artifactStore);
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const server = await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: masterKey,
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DATA_DIR: "/var/lib/devkh",
      KNOWLEDGE_PIPELINE_V2: "true"
    }, deps);

    const database = vi.mocked(deps.createDatabase).mock.results[0].value;
    const store = vi.mocked(deps.createStore).mock.results[0].value;
    const queue = vi.mocked(deps.createBuildQueue).mock.results[0].value;
    const qualityWorker = vi.mocked(deps.createQualityPipelineWorker).mock.results[0].value;
    const buildService = vi.mocked(deps.createBuildService).mock.results[0].value;
    expect(deps.createDatabase).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(deps.runMigrations).toHaveBeenCalledWith(database.pool);
    expect(deps.createStore).toHaveBeenCalledWith(database.pool);
    expect(deps.createBuildQueue).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(deps.createQualityPipelineWorker).toHaveBeenCalledWith("postgres://localhost/devkh", store, artifactStore);
    expect(qualityWorker.start).toHaveBeenCalledOnce();
    expect(deps.createBuildService).toHaveBeenCalledWith(store, queue, expect.any(Function), expect.any(Function));
    expect(deps.createArtifactStore).toHaveBeenCalledWith("/var/lib/devkh/artifacts", store);
    expect(artifactStore.initialize).toHaveBeenCalledOnce();
    expect(buildService.start).toHaveBeenCalledOnce();
    expect(deps.buildServer).toHaveBeenCalledWith(expect.objectContaining({
      store,
      buildService,
      masterKey,
      sessionSecret: "production-session-secret-at-least-32-chars",
      dataDir: "/var/lib/devkh",
      nodeEnv: "production",
      clientDir: path.resolve("dist/client"),
      sessionStore: expect.anything()
    }));
    expect(server.addHook).toHaveBeenCalledWith("onClose", expect.any(Function));
    expect(server).toBe(vi.mocked(deps.buildServer).mock.results[0].value);
  });

  test("keeps the staged quality worker inactive in the legacy default", async () => {
    const deps = dependencies();
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
    }, deps);

    expect(deps.createQualityPipelineWorker).not.toHaveBeenCalled();
    const schedulePostBuild = vi.mocked(deps.createBuildService).mock.calls[0]![3]!;
    await expect(schedulePostBuild({ id: "build-1" } as BuildRecord)).resolves.toBeUndefined();
  });

  test("queues one deterministic quality stage after a durable build", async () => {
    const deps = dependencies();
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      KNOWLEDGE_PIPELINE_V2: "true"
    }, deps);

    const persistedStore = vi.mocked(deps.createStore).mock.results[0].value as {
      getRepository: ReturnType<typeof vi.fn>;
      findSnapshotById: ReturnType<typeof vi.fn>;
      listSnapshotFiles: ReturnType<typeof vi.fn>;
      countKnowledgePagesForBuild: ReturnType<typeof vi.fn>;
    };
    persistedStore.getRepository = vi.fn(async () => ({ id: "repo-1", projectId: "project-1" }));
    persistedStore.findSnapshotById = vi.fn(async () => ({ id: "snapshot-1", commitSha: "a".repeat(40) }));
    persistedStore.listSnapshotFiles = vi.fn(async () => []);
    persistedStore.countKnowledgePagesForBuild = vi.fn(async () => 1);
    const schedulePostBuild = vi.mocked(deps.createBuildService).mock.calls[0]![3]!;
    const build: BuildRecord = {
      id: "build-1", workspaceId: "workspace-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
      snapshotPath: "/tmp/snapshot", commitSha: "a".repeat(40), status: "ready", warnings: [], cancelRequested: false,
      purpose: { kind: "standard", feedbackIds: [], feedbackContext: [], remediationContext: [] }
    };

    await schedulePostBuild(build);

    const qualityWorker = vi.mocked(deps.createQualityPipelineWorker).mock.results[0].value;
    expect(qualityWorker.schedule).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      stages: ["lint"], stageIndex: 0, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
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

  test("cleans expired import reports at startup, schedules hourly retries, and clears the timer on shutdown", async () => {
    const deps = dependencies();
    const interval = { id: "maintenance" };
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
    await vi.waitFor(() => expect(store.deleteExpiredImportReports).toHaveBeenCalledWith(expect.any(Date)));
    expect(store.deleteExpiredImportReports).toHaveBeenCalledWith(expect.any(Date));
    expect(store.listActiveGitRepositories).toHaveBeenCalledOnce();
    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);

    const onClose = vi.mocked(server.addHook).mock.calls.find(([name]) => name === "onClose")?.[1];
    await (onClose as () => Promise<void>)();

    expect(deps.clearInterval).toHaveBeenCalledWith(interval);
    expect(deps.reportBackgroundError).not.toHaveBeenCalled();
  });

});
