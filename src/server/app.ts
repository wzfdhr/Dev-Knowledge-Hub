import Fastify, { type FastifyInstance } from "fastify";

import { SERVICE_NAME } from "../shared/contracts.js";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get("/api/health", async () => ({
    status: "ok",
    service: SERVICE_NAME
  }));

  return server;
}
