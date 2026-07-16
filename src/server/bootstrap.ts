import type { Pool } from "pg";
import path from "node:path";

import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer } from "./app.js";
import { loadEnv, type EnvironmentMode } from "./env.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";
import type { AppStore } from "./persistence/store.js";
import { BuildService, type BuildJobQueue, type BuildRecord } from "./knowledge/build-service.js";
import { PgBossBuildJobQueue } from "./knowledge/job-queue.js";
import { anthropicEnhancer, openAiCompatibleEnhancer, type KnowledgeEnhancer } from "./knowledge/enhancer.js";
import { decryptSecret } from "./security/crypto.js";
import { syncRepository } from "./git/snapshot.js";
import { PostgresSessionStore } from "./security/session-store.js";
import { ArtifactStore } from "./knowledge/pipeline/artifact-store.js";
import type { PipelineArtifactStore } from "./persistence/store.js";
import { PipelineStageWorker, type PipelineStageSchedule } from "./knowledge/pipeline/worker.js";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "./knowledge/pipeline/convert-stage.js";
import { createKnowledgeIrStageExecutor } from "./knowledge/pipeline/extract-stage.js";
import { createTableSchemasStageExecutor } from "./knowledge/pipeline/tables-stage.js";
import { createKnowledgeGraphStageExecutor } from "./knowledge/pipeline/graph-stage.js";
import { createPipelineStageExecutor } from "./knowledge/pipeline/stage-executor.js";
import { createB02StageInputPlanner } from "./knowledge/pipeline/stage-planner.js";
import { createKnowledgeSynthesisStageExecutor } from "./knowledge/pipeline/synthesize-stage.js";
import { createPipelineSearchIndexStageExecutor } from "./knowledge/pipeline/index-stage.js";
import { createKnowledgeQualityStageExecutor } from "./knowledge/pipeline/quality-stage.js";
import { createKnowledgeVisualizationStageExecutor } from "./knowledge/pipeline/viz-stage.js";
import { PgBossPipelineStageJobQueue } from "./knowledge/job-queue.js";

const IMPORT_REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface ArtifactStoreInitializer {
  initialize(): Promise<void>;
}

interface QualityPipelineWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  schedule(job: PipelineStageSchedule): Promise<void>;
}

export interface BootstrapDependencies {
  createDatabase: typeof createDatabase;
  runMigrations: typeof runMigrations;
  createStore: (pool: Pool) => AppStore;
  createBuildQueue: (connectionString: string) => BuildJobQueue;
  createBuildService: (
    store: AppStore,
    queue: BuildJobQueue,
    enhancerForWorkspace: (workspaceId: string) => Promise<KnowledgeEnhancer | undefined>,
    schedulePostBuild: (build: BuildRecord) => Promise<void>
  ) => BuildService;
  createArtifactStore: (directory: string, persistence: PipelineArtifactStore) => ArtifactStoreInitializer;
  createQualityPipelineWorker: (
    connectionString: string,
    store: AppStore,
    artifactStore: ArtifactStoreInitializer
  ) => QualityPipelineWorker;
  buildServer: typeof buildServer;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  reportBackgroundError?: (operation: string, error: unknown) => void;
}

const defaultDependencies: BootstrapDependencies = {
  createDatabase,
  runMigrations,
  createStore: (pool) => new PostgresAppStore(pool),
  createBuildQueue: (connectionString) => new PgBossBuildJobQueue(connectionString),
  createBuildService: (store, queue, enhancerForWorkspace, schedulePostBuild) =>
    new BuildService(store, queue, { enhancerForWorkspace, schedulePostBuild }),
  createArtifactStore: (directory, persistence) => new ArtifactStore(directory, persistence),
  createQualityPipelineWorker: (connectionString, store, artifactStore) => {
    const pipelineStore = store as AppStore & PipelineArtifactStore;
    const pipelineArtifacts = artifactStore as ArtifactStore;
    return new PipelineStageWorker(
      pipelineStore,
      new PgBossPipelineStageJobQueue(connectionString),
      createPipelineStageExecutor({
        convert: createNormalizedSourcesStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        extract: createKnowledgeIrStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        tables: createTableSchemasStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        graph: createKnowledgeGraphStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        synthesize: createKnowledgeSynthesisStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        index: createPipelineSearchIndexStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        lint: createKnowledgeQualityStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts }),
        viz: createKnowledgeVisualizationStageExecutor({ store: pipelineStore, artifactStore: pipelineArtifacts })
      }),
      ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz"],
      5_000,
      createB02StageInputPlanner(pipelineStore)
    );
  },
  buildServer
};

export async function bootstrapServer(
  mode: EnvironmentMode,
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: BootstrapDependencies = defaultDependencies
) {
  const env = loadEnv({ mode, env: sourceEnv });
  if (env.knowledgeKernelMode === "active") {
    throw new Error("DEVKH_KNOWLEDGE_KERNEL_MODE=active is unavailable before F05");
  }
  if (!env.databaseUrl || !env.masterKey || !env.sessionSecret) {
    throw new Error(
      "DATABASE_URL, DEVKH_MASTER_KEY, and DEVKH_SESSION_SECRET are required for server startup"
    );
  }

  const database = dependencies.createDatabase(env.databaseUrl);
  await dependencies.runMigrations(database.pool);
  const store = dependencies.createStore(database.pool);
  const artifactStore = dependencies.createArtifactStore(
    path.join(env.dataDir, "artifacts"),
    store as AppStore & PipelineArtifactStore
  );
  await artifactStore.initialize();
  const queue = dependencies.createBuildQueue(env.databaseUrl);
  const enhancerForWorkspace = async (workspaceId: string): Promise<KnowledgeEnhancer | undefined> => {
    const config = await store.getModelConfig(workspaceId);
    if (!config) return undefined;
    const apiKey = decryptSecret(config.encryptedApiKey, env.masterKey!);
    return config.provider === "anthropic"
      ? anthropicEnhancer({ apiKey, model: config.model })
      : openAiCompatibleEnhancer({ apiKey, model: config.model });
  };
  // Before F05 the staged pipeline only runs as a shadow build. Legacy remains
  // the sole source for published knowledge even when the future active mode is set.
  const qualityWorker = env.knowledgeKernelMode === "shadow"
    ? dependencies.createQualityPipelineWorker(env.databaseUrl, store, artifactStore)
    : undefined;
  const schedulePostBuild = async (build: BuildRecord) => {
    if (!qualityWorker) return;
    const repository = await store.getRepository(build.workspaceId, build.repositoryId);
    const snapshot = await store.findSnapshotById(build.workspaceId, build.snapshotId);
    if (!repository || !snapshot) throw new Error("Shadow pipeline source is unavailable");
    const files = await store.listSnapshotFiles(build.workspaceId, build.snapshotId);
    await qualityWorker.schedule({
      workspaceId: build.workspaceId,
      projectId: repository.projectId,
      snapshotId: snapshot.id,
      buildId: build.id,
      inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
    });
  };
  const buildService = dependencies.createBuildService(store, queue, enhancerForWorkspace, schedulePostBuild);
  await qualityWorker?.start();
  try {
    await buildService.start();
  } catch (error) {
    await qualityWorker?.stop();
    throw error;
  }
  const server = dependencies.buildServer({
    store,
    buildService,
    masterKey: env.masterKey,
    sessionSecret: env.sessionSecret,
    dataDir: env.dataDir,
    nodeEnv: env.nodeEnv,
    ...(env.publicBaseUrl ? { publicBaseUrl: env.publicBaseUrl } : {}),
    ...(env.legacySessionReadUntil ? { legacySessionReadUntil: env.legacySessionReadUntil } : {}),
    ...(mode === "production" ? { clientDir: path.resolve("dist/client") } : {}),
    sessionStore: new PostgresSessionStore(database.pool)
  });
  const reportBackgroundError = dependencies.reportBackgroundError
    ?? ((operation: string, error: unknown) => server.log.error({ err: error }, operation));
  const runImportReportCleanup = () => {
    void store.deleteExpiredImportReports(new Date(Date.now() - IMPORT_REPORT_RETENTION_MS))
      .catch((error: unknown) => {
        reportBackgroundError("Import report cleanup failed", error);
      });
  };
  const runGitSynchronization = () => {
    void store.listActiveGitRepositories().then(async (repositories) => {
      await Promise.all(repositories.map(async (repository) => {
        const report = await store.createImportReport({
          workspaceId: repository.workspaceId,
          projectId: repository.projectId,
          repositoryId: repository.id,
          actorId: null,
          sourceKind: "git"
        });
        try {
          const credential = await store.repositoryCredential(repository.workspaceId, repository.id);
          const summary = await syncRepository({
            repository,
            dataDir: env.dataDir,
            store,
            ...(credential ? { token: decryptSecret(credential, env.masterKey!) } : {})
          });
          await store.finishImportReport(repository.workspaceId, report.id, {
            status: "succeeded",
            collectedFileCount: summary.fileCount,
            collectedTextBytes: summary.textBytes,
            ignored: summary.ignored,
            snapshotId: summary.snapshotId,
            failureCode: null
          });
          await store.recordAudit({
            workspaceId: repository.workspaceId,
            action: "repository.scheduled_sync_succeeded",
            resourceType: "repository",
            resourceId: repository.id,
            metadata: { unchanged: summary.unchanged, commitSha: summary.commitSha }
          });
        } catch (error) {
          await store.finishImportReport(repository.workspaceId, report.id, {
            status: "failed",
            collectedFileCount: 0,
            collectedTextBytes: 0,
            ignored: { total: 0, reasons: {} },
            snapshotId: null,
            failureCode: "SCHEDULED_SYNC_FAILED"
          }).catch(() => undefined);
          await store.recordAudit({
            workspaceId: repository.workspaceId,
            action: "repository.scheduled_sync_failed",
            resourceType: "repository",
            resourceId: repository.id,
            metadata: { code: "SCHEDULED_SYNC_FAILED" }
          }).catch(() => undefined);
          throw error;
        }
      }));
    }).catch((error: unknown) => {
      reportBackgroundError("Git synchronization failed", error);
    });
  };
  const runMaintenance = () => {
    runImportReportCleanup();
    runGitSynchronization();
  };
  runMaintenance();
  const scheduleCleanup = dependencies.setInterval
    ?? ((callback: () => void, delay: number) => globalThis.setInterval(callback, delay));
  const clearCleanup = dependencies.clearInterval
    ?? ((timer: unknown) => globalThis.clearInterval(timer as never));
  const cleanupInterval = scheduleCleanup(
    runMaintenance,
    60 * 60 * 1000
  );
  server.addHook("onClose", async () => {
    clearCleanup(cleanupInterval);
    await buildService.stop();
    await qualityWorker?.stop();
    await database.pool.end();
  });
  return server;
}

export function bootstrapProductionServer(
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: BootstrapDependencies = defaultDependencies
) {
  return bootstrapServer("production", sourceEnv, dependencies);
}
