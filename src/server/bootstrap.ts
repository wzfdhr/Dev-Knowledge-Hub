import type { Pool } from "pg";
import path from "node:path";

import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer } from "./app.js";
import { loadEnv, type EnvironmentMode } from "./env.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";
import type { AppStore } from "./persistence/store.js";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service.js";
import { PgBossBuildJobQueue } from "./knowledge/job-queue.js";
import { anthropicEnhancer, openAiCompatibleEnhancer, type KnowledgeEnhancer } from "./knowledge/enhancer.js";
import { decryptSecret } from "./security/crypto.js";

export interface BootstrapDependencies {
  createDatabase: typeof createDatabase;
  runMigrations: typeof runMigrations;
  createStore: (pool: Pool) => AppStore;
  createBuildQueue: (connectionString: string) => BuildJobQueue;
  createBuildService: (
    store: AppStore,
    queue: BuildJobQueue,
    enhancerForWorkspace: (workspaceId: string) => Promise<KnowledgeEnhancer | undefined>
  ) => BuildService;
  buildServer: typeof buildServer;
}

const defaultDependencies: BootstrapDependencies = {
  createDatabase,
  runMigrations,
  createStore: (pool) => new PostgresAppStore(pool),
  createBuildQueue: (connectionString) => new PgBossBuildJobQueue(connectionString),
  createBuildService: (store, queue, enhancerForWorkspace) =>
    new BuildService(store, queue, { enhancerForWorkspace }),
  buildServer
};

export async function bootstrapServer(
  mode: EnvironmentMode,
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: BootstrapDependencies = defaultDependencies
) {
  const env = loadEnv({ mode, env: sourceEnv });
  if (!env.databaseUrl || !env.masterKey || !env.sessionSecret) {
    throw new Error(
      "DATABASE_URL, DEVKH_MASTER_KEY, and DEVKH_SESSION_SECRET are required for server startup"
    );
  }

  const database = dependencies.createDatabase(env.databaseUrl);
  await dependencies.runMigrations(database.pool);
  const store = dependencies.createStore(database.pool);
  const queue = dependencies.createBuildQueue(env.databaseUrl);
  const enhancerForWorkspace = async (workspaceId: string): Promise<KnowledgeEnhancer | undefined> => {
    const config = await store.getModelConfig(workspaceId);
    if (!config) return undefined;
    const apiKey = decryptSecret(config.encryptedApiKey, env.masterKey!);
    return config.provider === "anthropic"
      ? anthropicEnhancer({ apiKey, model: config.model })
      : openAiCompatibleEnhancer({ apiKey, model: config.model });
  };
  const buildService = dependencies.createBuildService(store, queue, enhancerForWorkspace);
  await buildService.start();
  const server = dependencies.buildServer({
    store,
    buildService,
    masterKey: env.masterKey,
    sessionSecret: env.sessionSecret,
    dataDir: env.dataDir,
    nodeEnv: env.nodeEnv,
    ...(mode === "production" ? { clientDir: path.resolve("dist/client") } : {})
  });
  server.addHook("onClose", async () => {
    await buildService.stop();
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
