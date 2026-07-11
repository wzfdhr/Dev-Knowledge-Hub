import { buildServer } from "./app.js";
import { loadEnv, type EnvironmentMode } from "./env.js";

const mode = (process.env.NODE_ENV ?? "development") as EnvironmentMode;
const env = loadEnv({ mode, env: process.env });
const server = buildServer();

try {
  await server.listen({ host: env.host, port: env.port });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
