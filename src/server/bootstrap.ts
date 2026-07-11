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

export interface BootstrapDependencies {
  createDatabase: typeof createDatabase;
  runMigrations: typeof runMigrations;
  createStore: (pool: Pool) => AppStore;
  createBuildQueue: (connectionString: string) => BuildJobQueue;
  createBuildService: (store: AppStore, queue: BuildJobQueue) => BuildService;
  buildServer: typeof buildServer;
}

const defaultDependencies: BootstrapDependencies = {
  createDatabase,
  runMigrations,
  createStore: (pool) => new PostgresAppStore(pool),
  createBuildQueue: (connectionString) => new PgBossBuildJobQueue(connectionString),
  createBuildService: (store, queue) => new BuildService(store, queue),
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
  const buildService = dependencies.createBuildService(store, queue);
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
