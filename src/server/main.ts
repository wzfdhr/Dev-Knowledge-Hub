import { buildServer } from "./app.js";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { loadEnv, type EnvironmentMode } from "./env.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";

const mode = (process.env.NODE_ENV ?? "development") as EnvironmentMode;
const env = loadEnv({ mode, env: process.env });
const persistenceValues = [env.databaseUrl, env.masterKey, env.sessionSecret];
const configuredValues = persistenceValues.filter(Boolean).length;
if (configuredValues > 0 && configuredValues < persistenceValues.length) {
  throw new Error("DATABASE_URL, DEVKH_MASTER_KEY, and DEVKH_SESSION_SECRET must be configured together");
}

const database = env.databaseUrl ? createDatabase(env.databaseUrl) : null;
if (database) await runMigrations(database.pool);
const server = buildServer(database && env.masterKey && env.sessionSecret ? {
  store: new PostgresAppStore(database.pool),
  masterKey: env.masterKey,
  sessionSecret: env.sessionSecret,
  dataDir: env.dataDir,
  nodeEnv: env.nodeEnv
} : {
  dataDir: env.dataDir,
  nodeEnv: env.nodeEnv
});
if (database) server.addHook("onClose", () => database.pool.end());

try {
  await server.listen({ host: env.host, port: env.port });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
