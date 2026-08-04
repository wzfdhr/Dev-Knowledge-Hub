import { describe, expect, test, vi } from "vitest";
import path from "node:path";

import { bootstrapProductionServer, type BootstrapDependencies } from "./bootstrap";
import type { BuildRecord } from "./knowledge/build-service";
import { normalizedSourcesPipelineInputDigest } from "./knowledge/pipeline/convert-stage";

function dependencies(): BootstrapDependencies {
  const pool = { durable: true, end: vi.fn(async () => {}) };
  const store = {
    durable: true,
    deleteExpiredImportReports: vi.fn(async () => 0),
    claimDueGitSynchronizations: vi.fn(async () => []),
    getProjectFrontendRollout: vi.fn(async () => null)
  };
  const queue = { durable: true };
  const qualityWorker = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {})
  };
  const buildService = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const sourceBlobStore = {
    initialize: vi.fn(async () => {}),
    verifyHardlinkSupport: vi.fn(async () => {})
  };
  const server = { durable: true, addHook: vi.fn() };
  return {
    createDatabase: vi.fn(() => ({ pool } as never)),
    runMigrations: vi.fn(async () => []),
    createStore: vi.fn(() => store as never),
    createBuildQueue: vi.fn(() => queue as never),
    createBuildService: vi.fn(() => buildService as never),
    createArtifactStore: vi.fn(() => ({ initialize: vi.fn(async () => {}) })),
    createSourceBlobStore: vi.fn(() => sourceBlobStore as never),
    createParserClient: vi.fn(() => ({ analyze: vi.fn(async () => ({ outputs: [] })) })),
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

  test("starts the staged pipeline worker only in explicit shadow mode", async () => {
    const deps = dependencies();
    const artifactStore = { initialize: vi.fn(async () => {}) };
    (deps as BootstrapDependencies & { createArtifactStore: (directory: string) => typeof artifactStore }).createArtifactStore = vi.fn(() => artifactStore);
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const server = await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: masterKey,
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DATA_DIR: "/var/lib/devkh",
      DEVKH_KNOWLEDGE_KERNEL_MODE: "shadow",
      DEVKH_FRONTEND_KNOWLEDGE_MODE: "shadow"
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
    expect(deps.createQualityPipelineWorker).toHaveBeenCalledWith(
      "postgres://localhost/devkh", store, artifactStore, expect.any(Function), expect.any(Function), expect.anything(),
      "legacy", expect.anything()
    );
    expect(deps.createParserClient).toHaveBeenCalledWith("/run/devkh-parser/parser.sock");
    const frontendModeForProject = vi.mocked(deps.createQualityPipelineWorker).mock.calls[0]![4]!;
    await expect(frontendModeForProject("workspace-1", "project-1")).resolves.toBe("legacy");
    vi.mocked(store.getProjectFrontendRollout).mockResolvedValueOnce({ mode: "shadow" } as never);
    await expect(frontendModeForProject("workspace-1", "project-1")).resolves.toBe("shadow");
    expect(qualityWorker.start).toHaveBeenCalledOnce();
    expect(deps.createBuildService).toHaveBeenCalledWith(
      store, queue, expect.any(Function), expect.any(Function), expect.any(Function)
    );
    expect(deps.createArtifactStore).toHaveBeenCalledWith("/var/lib/devkh/artifacts", store);
    expect(deps.createSourceBlobStore).toHaveBeenCalledWith("/var/lib/devkh/snapshots", store);
    const sourceBlobStore = vi.mocked(deps.createSourceBlobStore).mock.results[0].value;
    expect(sourceBlobStore.initialize).toHaveBeenCalledOnce();
    expect(sourceBlobStore.verifyHardlinkSupport).not.toHaveBeenCalled();
    expect(artifactStore.initialize).toHaveBeenCalledOnce();
    expect(buildService.start).toHaveBeenCalledOnce();
    expect(deps.buildServer).toHaveBeenCalledWith(expect.objectContaining({
      store,
      buildService,
      masterKey,
      sessionSecret: "production-session-secret-at-least-32-chars",
      dataDir: "/var/lib/devkh",
      nodeEnv: "production",
      knowledgeKernelMode: "shadow",
      frontendKnowledgeMode: "shadow",
      sourceStorageMode: "legacy",
      sourceBlobStore,
      clientDir: path.resolve("dist/client"),
      sessionStore: expect.anything()
    }));
    expect(server.addHook).toHaveBeenCalledWith("onClose", expect.any(Function));
    expect(server).toBe(vi.mocked(deps.buildServer).mock.results[0].value);
  });

  test("requires a successful hardlink probe before source blob shadow mode starts", async () => {
    const deps = dependencies();
    const sourceBlobStore = vi.mocked(deps.createSourceBlobStore).mock.results;
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DEVKH_SOURCE_STORAGE_MODE: "shadow"
    }, deps);

    expect(sourceBlobStore[0]!.value.verifyHardlinkSupport).toHaveBeenCalledOnce();
  });

  test("refuses to start source blob shadow mode when the hardlink probe fails", async () => {
    const deps = dependencies();
    const sourceBlobStore = {
      initialize: vi.fn(async () => {}),
      verifyHardlinkSupport: vi.fn(async () => { throw new Error("hardlinks unavailable"); })
    };
    vi.mocked(deps.createSourceBlobStore).mockReturnValue(sourceBlobStore as never);

    await expect(bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DEVKH_SOURCE_STORAGE_MODE: "shadow"
    }, deps)).rejects.toThrow("hardlinks unavailable");

    expect(sourceBlobStore.verifyHardlinkSupport).toHaveBeenCalledOnce();
    expect(deps.buildServer).not.toHaveBeenCalled();
  });

  test("keeps the staged pipeline worker inactive in the legacy default", async () => {
    const deps = dependencies();
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
    }, deps);

    expect(deps.createQualityPipelineWorker).not.toHaveBeenCalled();
    const schedulePostBuild = vi.mocked(deps.createBuildService).mock.calls[0]![4]!;
    await expect(schedulePostBuild({ id: "build-1" } as BuildRecord)).resolves.toBeUndefined();
  });

  test("starts the staged pipeline worker in F05 active mode", async () => {
    const deps = dependencies();
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DEVKH_KNOWLEDGE_KERNEL_MODE: "active",
      DEVKH_FRONTEND_KNOWLEDGE_MODE: "active",
      DEVKH_SOURCE_STORAGE_MODE: "active"
    }, deps);

    expect(deps.createQualityPipelineWorker).toHaveBeenCalledOnce();
    expect(deps.createBuildService).toHaveBeenCalledOnce();
    const sourceBlobStore = vi.mocked(deps.createSourceBlobStore).mock.results[0]!.value;
    expect(sourceBlobStore.verifyHardlinkSupport).toHaveBeenCalledOnce();
    expect(deps.buildServer).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeKernelMode: "active",
      frontendKnowledgeMode: "active",
      sourceStorageMode: "active"
    }));
  });

  test.each(["shadow", "active"] as const)("queues the deterministic pipeline stage in %s mode after a durable build", async (kernelMode) => {
    const deps = dependencies();
    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars",
      DEVKH_KNOWLEDGE_KERNEL_MODE: kernelMode
    }, deps);

    const initialPipelineStage = vi.mocked(deps.createBuildService).mock.calls[0]![3]!;
    const schedulePostBuild = vi.mocked(deps.createBuildService).mock.calls[0]![4]!;
    const build: BuildRecord = {
      id: "build-1", workspaceId: "workspace-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
      snapshotPath: "/tmp/snapshot", commitSha: "a".repeat(40), status: "ready", warnings: [], cancelRequested: false,
      purpose: { kind: "standard", feedbackIds: [], feedbackContext: [], remediationContext: [] }
    };

    const initialStage = initialPipelineStage!(build, []);
    await schedulePostBuild(build, { stageRunId: "stage-1", projectId: "project-1" });

    const qualityWorker = vi.mocked(deps.createQualityPipelineWorker).mock.results[0].value;
    expect(initialStage).toEqual({
      inputDigest: normalizedSourcesPipelineInputDigest(
        { id: "snapshot-1", commitSha: "a".repeat(40) },
        [],
        build.purpose
      )
    });
    expect(qualityWorker.dispatch).toHaveBeenCalledWith({
      stageRunId: "stage-1", buildId: "build-1", projectId: "project-1"
    });
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
    expect(store.claimDueGitSynchronizations).toHaveBeenCalledWith(expect.any(Date), 10, 15 * 60 * 1000);
    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);

    const onClose = vi.mocked(server.addHook).mock.calls.find(([name]) => name === "onClose")?.[1];
    await (onClose as () => Promise<void>)();

    expect(deps.clearInterval).toHaveBeenCalledWith(interval);
    expect(deps.reportBackgroundError).not.toHaveBeenCalled();
  });

  test("backs off a claimed synchronization when its import report cannot be created", async () => {
    const deps = dependencies();
    const repository = {
      id: "repo-1", workspaceId: "workspace-1", projectId: "project-1", kind: "git",
      name: "Source", localPath: null, cloneUrl: "https://github.com/example/source.git",
      defaultBranch: "main", archivedAt: null, hasCredential: false
    };
    const durableStore = {
      durable: true,
      deleteExpiredImportReports: vi.fn(async () => 0),
      claimDueGitSynchronizations: vi.fn(async () => [{ repository, leaseToken: "lease-1" }]),
      createImportReport: vi.fn(async () => { throw new Error("import report unavailable"); }),
      finishGitSynchronization: vi.fn(async () => true),
      recordAudit: vi.fn(async () => undefined)
    };
    vi.mocked(deps.createStore).mockImplementation(() => durableStore as never);
    deps.reportBackgroundError = vi.fn();

    await bootstrapProductionServer({
      DATABASE_URL: "postgres://localhost/devkh",
      DEVKH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DEVKH_SESSION_SECRET: "production-session-secret-at-least-32-chars"
    }, deps);

    await vi.waitFor(() => expect(durableStore.finishGitSynchronization).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: repository.id,
      leaseToken: "lease-1",
      status: "failed",
      failureCode: "SCHEDULED_SYNC_FAILED"
    })));
  });

});
