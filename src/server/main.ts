import { bootstrapServer } from "./bootstrap.js";
import type { EnvironmentMode } from "./env.js";
import { installSignalShutdown } from "./lifecycle.js";

const mode = (process.env.NODE_ENV ?? "development") as EnvironmentMode;
const server = await bootstrapServer(mode, process.env);

try {
  await server.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  });
  installSignalShutdown(server);
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
  await server.close();
}
