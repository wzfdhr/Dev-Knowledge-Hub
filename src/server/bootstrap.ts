import type { Pool } from "pg";
import path from "node:path";

import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer } from "./app.js";
import { loadEnv, type EnvironmentMode } from "./env.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";
import type { AppStore } from "./persistence/store.js";
import {
  BuildService,
  type BuildJobQueue,
  type BuildRecord,
  type InitialPipelineStage,
  type PersistedInitialPipelineStage,
  type SnapshotFileMetadata
} from "./knowledge/build-service.js";
import { PgBossBuildJobQueue } from "./knowledge/job-queue.js";
import { anthropicEnhancer, openAiCompatibleEnhancer, type KnowledgeEnhancer } from "./knowledge/enhancer.js";
import { decryptSecret } from "./security/crypto.js";
import { syncRepository } from "./git/snapshot.js";
import { GitCommandTimeoutError } from "./git/remote.js";
import { PostgresSessionStore } from "./security/session-store.js";
import { ArtifactStore } from "./knowledge/pipeline/artifact-store.js";
import type { PipelineArtifactStore } from "./persistence/store.js";
import {
  PipelineStageWorker,
  type PipelineStageJob,
  type PipelineStageSchedule
} from "./knowledge/pipeline/worker.js";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "./knowledge/pipeline/convert-stage.js";
import { createKnowledgeIrStageExecutor } from "./knowledge/pipeline/extract-stage.js";
import { createTableSchemasStageExecutor } from "./knowledge/pipeline/tables-stage.js";
import { createKnowledgeGraphStageExecutor } from "./knowledge/pipeline/graph-stage.js";
import { createPipelineStageExecutor } from "./knowledge/pipeline/stage-executor.js";
import { createKnowledgeSynthesisStageExecutor } from "./knowledge/pipeline/synthesize-stage.js";
import { createPipelineSearchIndexStageExecutor } from "./knowledge/pipeline/index-stage.js";
import { createKnowledgeQualityStageExecutor } from "./knowledge/pipeline/quality-stage.js";
import { createKnowledgeVisualizationStageExecutor } from "./knowledge/pipeline/viz-stage.js";
import { createKnowledgeValidationStageExecutor } from "./knowledge/pipeline/validate-stage.js";
import { createKnowledgePackageStageExecutor } from "./knowledge/pipeline/package-stage.js";
import { PgBossPipelineStageJobQueue } from "./knowledge/job-queue.js";
import {
  createFrontendModeStageInputPlanner,
  createFrontendShadowStageExecutor,
  createKnowledgeV1StoreView
} from "./knowledge/frontend/shadow-stage.js";
import type { FrontendParserClient } from "./knowledge/frontend/shadow-stage.js";
import {
  effectiveFrontendKnowledgeMode,
  type FrontendKnowledgeMode
} from "./knowledge/frontend/rollout-mode.js";
import { ParserClient } from "./knowledge/frontend/runtime/parser-client.js";

const IMPORT_REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GIT_SYNC_CLAIM_LIMIT = 10;
const GIT_SYNC_LEASE_DURATION_MS = 15 * 60 * 1000;
const GIT_SYNC_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

function scheduledGitSyncFailureCode(error: unknown): string {
  return error instanceof GitCommandTimeoutError ? error.code : "SCHEDULED_SYNC_FAILED";
}

interface ArtifactStoreInitializer {
  initialize(): Promise<void>;
}

interface QualityPipelineWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  schedule(job: PipelineStageSchedule): Promise<void>;
  dispatch(job: PipelineStageJob): Promise<void>;
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
    initialPipelineStage: (
      build: BuildRecord,
      files: readonly SnapshotFileMetadata[]
    ) => InitialPipelineStage | undefined,
    schedulePostBuild: (build: BuildRecord, stage?: PersistedInitialPipelineStage) => Promise<void>
  ) => BuildService;
  createArtifactStore: (directory: string, persistence: PipelineArtifactStore) => ArtifactStoreInitializer;
  createParserClient: (socketPath: string) => FrontendParserClient;
  createQualityPipelineWorker: (
    connectionString: string,
    store: AppStore,
    artifactStore: ArtifactStoreInitializer,
    enhancerForWorkspace: ((workspaceId: string) => Promise<KnowledgeEnhancer | undefined>) | undefined,
    frontendModeForProject: (
      workspaceId: string,
      projectId: string
    ) => Promise<FrontendKnowledgeMode>,
    frontendParser: FrontendParserClient
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
  createBuildService: (store, queue, enhancerForWorkspace, initialPipelineStage, schedulePostBuild) =>
    new BuildService(store, queue, { enhancerForWorkspace, initialPipelineStage, schedulePostBuild }),
  createArtifactStore: (directory, persistence) => new ArtifactStore(directory, persistence),
  createParserClient: (socketPath) => new ParserClient({ socketPath }),
  createQualityPipelineWorker: (
    connectionString, store, artifactStore, enhancerForWorkspace, frontendModeForProject, frontendParser
  ) => {
    const pipelineStore = store as AppStore & PipelineArtifactStore;
    const pipelineArtifacts = artifactStore as ArtifactStore;
    const knowledgeV1Store = createKnowledgeV1StoreView(pipelineStore);
    const legacyExecutor = createPipelineStageExecutor({
      convert: createNormalizedSourcesStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      extract: createKnowledgeIrStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      tables: createTableSchemasStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      graph: createKnowledgeGraphStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      synthesize: createKnowledgeSynthesisStageExecutor({
        store: knowledgeV1Store, artifactStore: pipelineArtifacts, enhancerForWorkspace
      }),
      index: createPipelineSearchIndexStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      lint: createKnowledgeQualityStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      viz: createKnowledgeVisualizationStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      validate: createKnowledgeValidationStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts }),
      package: createKnowledgePackageStageExecutor({ store: knowledgeV1Store, artifactStore: pipelineArtifacts })
    });
    return new PipelineStageWorker(
      pipelineStore,
      new PgBossPipelineStageJobQueue(connectionString),
      createFrontendShadowStageExecutor({
        store: pipelineStore, artifactStore: pipelineArtifacts, legacy: legacyExecutor, frontendParser
      }),
      ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"],
      5_000,
      createFrontendModeStageInputPlanner(pipelineStore, frontendModeForProject)
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
  const frontendModeForProject = async (
    workspaceId: string,
    projectId: string
  ): Promise<FrontendKnowledgeMode> => {
    const rollout = await store.getProjectFrontendRollout(workspaceId, projectId);
    return effectiveFrontendKnowledgeMode({
      kernelMode: env.knowledgeKernelMode,
      systemMode: env.frontendKnowledgeMode,
      ...(rollout ? { projectMode: rollout.mode } : {})
    });
  };
  // Before F05 the staged pipeline only runs as a shadow build. Legacy remains
  // the sole source for published knowledge even when the future active mode is set.
  const qualityWorker = env.knowledgeKernelMode === "shadow"
    ? dependencies.createQualityPipelineWorker(
      env.databaseUrl, store, artifactStore, enhancerForWorkspace, frontendModeForProject,
      dependencies.createParserClient(env.parserSocketPath)
    )
    : undefined;
  const initialPipelineStage = qualityWorker
    ? (build: BuildRecord, files: readonly SnapshotFileMetadata[]): InitialPipelineStage => ({
      inputDigest: normalizedSourcesPipelineInputDigest({
        id: build.snapshotId,
        commitSha: build.commitSha
      }, files, build.purpose)
    })
    : () => undefined;
  const schedulePostBuild = async (build: BuildRecord, stage?: PersistedInitialPipelineStage) => {
    if (!qualityWorker || !stage) return;
    await qualityWorker.dispatch({
      stageRunId: stage.stageRunId,
      buildId: build.id,
      projectId: stage.projectId
    });
  };
  const buildService = dependencies.createBuildService(
    store,
    queue,
    enhancerForWorkspace,
    initialPipelineStage,
    schedulePostBuild
  );
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
    sessionStore: new PostgresSessionStore(database.pool),
    qualityArtifactReader: artifactStore as ArtifactStore,
    knowledgeKernelMode: env.knowledgeKernelMode,
    frontendKnowledgeMode: env.frontendKnowledgeMode
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
    void store.claimDueGitSynchronizations(
      new Date(), GIT_SYNC_CLAIM_LIMIT, GIT_SYNC_LEASE_DURATION_MS
    ).then(async (claims) => {
      await Promise.all(claims.map(async ({ repository, leaseToken }) => {
        let report: Awaited<ReturnType<typeof store.createImportReport>> | null = null;
        try {
          report = await store.createImportReport({
            workspaceId: repository.workspaceId,
            projectId: repository.projectId,
            repositoryId: repository.id,
            actorId: null,
            sourceKind: "git"
          });
          const credential = await store.repositoryCredential(repository.workspaceId, repository.id);
          const summary = await syncRepository({
            repository,
            dataDir: env.dataDir,
            store,
            gitTimeoutMs: GIT_SYNC_COMMAND_TIMEOUT_MS,
            gitSynchronizationLease: { repositoryId: repository.id, leaseToken },
            ...(credential ? { token: decryptSecret(credential, env.masterKey!) } : {})
          });
          const completed = await store.finishGitSynchronization({
            repositoryId: repository.id,
            leaseToken,
            status: "succeeded",
            now: new Date()
          });
          if (!completed) {
            await store.finishImportReport(repository.workspaceId, report.id, {
              status: "failed",
              collectedFileCount: 0,
              collectedTextBytes: 0,
              ignored: { total: 0, reasons: {} },
              snapshotId: null,
              failureCode: "SCHEDULED_SYNC_LEASE_EXPIRED"
            }).catch(() => undefined);
            return;
          }
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
          const completed = await store.finishGitSynchronization({
            repositoryId: repository.id,
            leaseToken,
            status: "failed",
            failureCode: scheduledGitSyncFailureCode(error),
            now: new Date()
          }).catch(() => false);
          if (report) {
            await store.finishImportReport(repository.workspaceId, report.id, {
              status: "failed",
              collectedFileCount: 0,
              collectedTextBytes: 0,
              ignored: { total: 0, reasons: {} },
              snapshotId: null,
              failureCode: completed ? scheduledGitSyncFailureCode(error) : "SCHEDULED_SYNC_LEASE_EXPIRED"
            }).catch(() => undefined);
          }
          if (completed) {
            await store.recordAudit({
              workspaceId: repository.workspaceId,
              action: "repository.scheduled_sync_failed",
              resourceType: "repository",
              resourceId: repository.id,
              metadata: { code: scheduledGitSyncFailureCode(error) }
            }).catch(() => undefined);
          }
          reportBackgroundError("Git synchronization failed", error);
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
