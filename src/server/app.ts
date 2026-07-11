import Fastify, { type FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get("/api/health", async () => ({
    status: "ok",
    service: "dev-knowledge-hub"
  }));

  return server;
}
