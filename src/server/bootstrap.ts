import type { Pool } from "pg";

import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer } from "./app.js";
import { loadEnv, type EnvironmentMode } from "./env.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";
import type { AppStore } from "./persistence/store.js";

export interface BootstrapDependencies {
  createDatabase: typeof createDatabase;
  runMigrations: typeof runMigrations;
  createStore: (pool: Pool) => AppStore;
  buildServer: typeof buildServer;
}

const defaultDependencies: BootstrapDependencies = {
  createDatabase,
  runMigrations,
  createStore: (pool) => new PostgresAppStore(pool),
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
  const server = dependencies.buildServer({
    store: dependencies.createStore(database.pool),
    masterKey: env.masterKey,
    sessionSecret: env.sessionSecret,
    dataDir: env.dataDir,
    nodeEnv: env.nodeEnv
  });
  server.addHook("onClose", () => database.pool.end());
  return server;
}

export function bootstrapProductionServer(
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: BootstrapDependencies = defaultDependencies
) {
  return bootstrapServer("production", sourceEnv, dependencies);
}
