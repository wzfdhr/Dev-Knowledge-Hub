import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";

import { AGENT_FEEDBACK_STATUSES, SERVICE_NAME } from "../shared/contracts.js";
import {
  FeedbackNotAcknowledgedError,
  InvalidFeedbackTransitionError,
  type AdminRecord,
  type AppStore,
  type RepositoryRecord
} from "./persistence/store.js";
import { decryptSecret, encryptSecret } from "./security/crypto.js";
import { DirtyWorktreeError, syncRepository } from "./git/snapshot.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { createSessionToken, verifySessionToken } from "./security/session.js";
import type { BuildEvent, BuildService } from "./knowledge/build-service.js";
import {
  authenticateMcpToken,
  createMcpAuthorizationGuard,
  generateMcpToken,
  hashMcpToken,
  sanitizedMcpToken
} from "./mcp/auth.js";
import { createRegisteredMcpServer, MCP_TOOL_NAMES } from "./mcp/tools.js";
import {
  DEFAULT_RATE_LIMITS,
  MAX_REQUEST_BODY_BYTES,
  registerHttpSecurity,
  type RateLimitPolicy
} from "./security/http.js";

const SESSION_COOKIE = "devkh_session";
const SESSION_MAX_AGE = 8 * 60 * 60;

const credentialsSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(12)
});

const repositorySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    path: z.string().min(1),
    name: z.string().trim().min(1)
  }),
  z.object({
    kind: z.literal("git"),
    url: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    name: z.string().trim().min(1),
    token: z.string().min(1).optional()
  })
]);

const paginationQuerySchema = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
};

function paginationMetadata(total: number, offset: number, itemCount: number) {
  const consumed = offset + itemCount;
  return {
    total,
    nextOffset: consumed < total ? consumed : null
  };
}

export interface ServerOptions {
  store: AppStore;
  buildService?: BuildService;
  masterKey: string;
  sessionSecret: string;
  dataDir: string;
  nodeEnv: "development" | "production" | "test";
  clientDir?: string;
  rateLimits?: RateLimitPolicy;
}

function sseEvent(event: BuildEvent): string {
  return `id: ${event.sequence}\nevent: build\ndata: ${JSON.stringify(event)}\n\n`;
}

interface AuthenticatedRequest extends FastifyRequest {
  sessionAdmin: AdminRecord;
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function repositoryDto(repository: RepositoryRecord) {
  return {
    repository: {
      id: repository.id,
      kind: repository.kind,
      name: repository.name,
      ...(repository.kind === "local"
        ? { path: repository.localPath }
        : { url: repository.cloneUrl, hasCredential: repository.hasCredential }),
      defaultBranch: repository.defaultBranch
    }
  };
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const server = Fastify({
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    logger: options.nodeEnv === "test" || process.env.NODE_ENV === "test" ? false : {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.token",
          "req.body.apiKey",
          "req.body.providerApiKey"
        ],
        censor: "[REDACTED]"
      }
    }
  });
  registerHttpSecurity(server, options.rateLimits ?? DEFAULT_RATE_LIMITS);
  server.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    if (statusCode === 413) {
      return sendError(reply, 413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB");
    }
    request.log.error({ err: error }, "Request failed");
    return sendError(reply, statusCode, "REQUEST_FAILED", "Request failed");
  });
  void server.register(cookie);
  if (options.clientDir) {
    void server.register(fastifyStatic, { root: options.clientDir });
    server.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && request.url !== "/mcp") {
        return reply.sendFile("index.html");
      }
      return sendError(reply, 404, "NOT_FOUND", "Route was not found");
    });
  }

  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.nodeEnv === "production",
    maxAge: SESSION_MAX_AGE
  };

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    try {
      const session = await verifySessionToken(token, options.sessionSecret);
      const admin = await options.store.findAdminById(session.adminId, session.workspaceId);
      if (!admin) throw new Error("Unknown session administrator");
      (request as AuthenticatedRequest).sessionAdmin = admin;
    } catch {
      sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }
  }

  server.get("/api/health", async () => ({ status: "ok", service: SERVICE_NAME }));

  server.get("/api/setup/status", async () => ({
    setupRequired: !(await options.store.isSetupComplete())
  }));

  server.post("/api/setup", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid setup details");
    if (await options.store.isSetupComplete()) {
      return sendError(reply, 409, "SETUP_COMPLETE", "Setup has already been completed");
    }

    const result = await options.store.createInitialSetup(
      parsed.data.email,
      await hashPassword(parsed.data.password)
    );
    if (!result) return sendError(reply, 409, "SETUP_COMPLETE", "Setup has already been completed");

    return reply.code(201).send({
      workspace: result.workspace,
      admin: { id: result.admin.id, email: result.admin.email }
    });
  });

  server.post("/api/session", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    const workspace = await options.store.defaultWorkspace();
    const admin = parsed.success ? await options.store.findAdminByEmail(parsed.data.email) : null;
    const valid = parsed.success && admin
      ? await verifyPassword(admin.passwordHash, parsed.data.password)
      : false;

    if (!valid || !admin) {
      if (workspace) {
        void options.store.recordAudit({
          workspaceId: workspace.id,
          action: "session.login_failed",
          resourceType: "session",
          metadata: { email: parsed.success ? parsed.data.email : "invalid" }
        }).catch(() => undefined);
      }
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const token = await createSessionToken(
      { adminId: admin.id, workspaceId: admin.workspaceId },
      options.sessionSecret
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    void options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "session.login_succeeded",
      resourceType: "session"
    }).catch(() => undefined);
    return { authenticated: true, admin: { id: admin.id, email: admin.email } };
  });

  server.delete("/api/session", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  server.get("/api/session", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return { authenticated: true, admin: { id: admin.id, email: admin.email } };
  });

  const modelConfigDto = (config: Awaited<ReturnType<AppStore["getModelConfig"]>>) => ({
    config: config ? { provider: config.provider, model: config.model, hasApiKey: true } : null
  });

  server.get("/api/settings/model", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return modelConfigDto(await options.store.getModelConfig(admin.workspaceId));
  });

  server.put("/api/settings/model", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      provider: z.enum(["openai", "anthropic"]),
      model: z.string().trim().min(1).max(200),
      apiKey: z.string().max(10_000).optional().default("")
    }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid model settings");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const config = await options.store.upsertModelConfig(admin.workspaceId, {
        provider: parsed.data.provider,
        model: parsed.data.model,
        ...(parsed.data.apiKey ? { encryptedApiKey: encryptSecret(parsed.data.apiKey, options.masterKey) } : {})
      }, admin.id);
      return modelConfigDto(config);
    } catch (error) {
      return sendError(reply, 400, "MODEL_CONFIG_INVALID", error instanceof Error ? error.message : "Model settings failed");
    }
  });

  server.post("/api/mcp/tokens", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const plaintext = generateMcpToken();
    try {
      const token = await options.store.createMcpTokenWithAudit({
        workspaceId: admin.workspaceId,
        name: parsed.data.name,
        tokenHash: hashMcpToken(plaintext),
        tokenPrefix: plaintext.slice(0, 12)
      }, admin.id);
      return reply.code(201).send({ ...sanitizedMcpToken(token), token: plaintext });
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token creation failed");
    }
  });

  server.get("/api/mcp/tokens", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid pagination");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const [tokens, total] = await Promise.all([
      options.store.listMcpTokens(admin.workspaceId, parsed.data),
      options.store.countMcpTokens(admin.workspaceId)
    ]);
    return {
      tokens: tokens.map(sanitizedMcpToken),
      ...paginationMetadata(total, parsed.data.offset ?? 0, tokens.length)
    };
  });

  server.post("/api/mcp/tokens/:id/revoke", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const token = await options.store.revokeMcpTokenWithAudit(
        admin.workspaceId, parsed.data.id, admin.id
      );
      if (!token) return sendError(reply, 404, "TOKEN_NOT_FOUND", "MCP token was not found");
      return { token: sanitizedMcpToken(token) };
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token revocation failed");
    }
  });

  server.get("/api/mcp/connection", { preHandler: requireAdmin }, async () => ({
    endpoint: "/mcp",
    transport: "streamable-http",
    authorization: "bearer",
    stdioCommand: "npm run mcp:stdio",
    tools: MCP_TOOL_NAMES
  }));

  server.post("/api/repositories", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const parsed = repositorySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid repository connection");
    }
    const input = parsed.data.kind === "local"
      ? parsed.data
      : {
          kind: parsed.data.kind,
          name: parsed.data.name,
          url: parsed.data.url,
          ...(parsed.data.token
            ? { encryptedToken: encryptSecret(parsed.data.token, options.masterKey) }
            : {})
        };
    const repository = await options.store.createRepositoryWithAudit(
      admin.workspaceId,
      input,
      admin.id
    );
    if (!repository) {
      return sendError(reply, 409, "REPOSITORY_EXISTS", "A repository is already connected");
    }
    return reply.code(201).send(repositoryDto(repository));
  });

  server.get("/api/repositories/current", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return repositoryDto(repository);
  });

  server.get("/api/repositories/current/status", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const latest = await options.store.latestSnapshot(admin.workspaceId, repository.id);
    return {
      ...repositoryDto(repository),
      latestSnapshot: latest ? {
        id: latest.id,
        commitSha: latest.commitSha,
        ref: latest.ref,
        commitTimestamp: latest.commitTimestamp
      } : null
    };
  });

  server.post(
    "/api/repositories/current/sync",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const repository = await options.store.currentRepository(admin.workspaceId);
      if (!repository) {
        return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
      }
      try {
        const encryptedCredential = await options.store.repositoryCredential(
          admin.workspaceId,
          repository.id
        );
        const summary = await syncRepository({
          repository,
          dataDir: options.dataDir,
          store: options.store,
          actorId: admin.id,
          ...(encryptedCredential
            ? { token: decryptSecret(encryptedCredential, options.masterKey) }
            : {})
        });
        return summary;
      } catch (error) {
        const code = error instanceof DirtyWorktreeError ? error.code : "SYNC_FAILED";
        void options.store.recordAudit({
          workspaceId: admin.workspaceId,
          actorId: admin.id,
          action: "repository.sync_failed",
          resourceType: "repository",
          resourceId: repository.id,
          metadata: { code }
        }).catch(() => undefined);
        if (error instanceof DirtyWorktreeError) {
          return reply.code(409).send({
            error: { code: error.code, message: error.message, changedPaths: error.changedPaths }
          });
        }
        return sendError(reply, 500, "SYNC_FAILED", "Repository synchronization failed");
      }
    }
  );

  server.post("/api/builds", { preHandler: requireAdmin }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const parsed = z.object({ snapshotId: z.uuid() }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid build request");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, parsed.data.snapshotId);
    if (!snapshot || snapshot.repositoryId !== repository.id) {
      return sendError(reply, 404, "SNAPSHOT_NOT_FOUND", "Snapshot was not found");
    }
    const result = await options.buildService.startBuild({
      workspaceId: admin.workspaceId,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath,
      commitSha: snapshot.commitSha
    });
    return reply.code(result.created ? 202 : 200).send(result);
  });

  server.get("/api/builds", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid pagination");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const [builds, total] = await Promise.all([
      options.store.listBuilds(admin.workspaceId, repository.id, parsed.data),
      options.store.countBuilds(admin.workspaceId, repository.id)
    ]);
    return {
      builds,
      ...paginationMetadata(total, parsed.data.offset ?? 0, builds.length)
    };
  });

  server.get("/api/builds/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const build = parsed.success
      ? await options.store.getBuild(admin.workspaceId, parsed.data.id)
      : null;
    if (!build) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    return { build };
  });

  server.post("/api/builds/:id/cancel", { preHandler: requireAdmin }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const build = parsed.success
      ? await options.buildService.cancelBuild(admin.workspaceId, parsed.data.id)
      : null;
    if (!build) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    return { build };
  });

  server.get("/api/builds/:id/events", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const query = z.object({ once: z.string().optional(), ...paginationQuerySchema })
      .safeParse(request.query);
    if (!params.success || !query.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid build event request");
    }
    const build = await options.store.getBuild(admin.workspaceId, params.data.id);
    if (!build) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    const buffered = new Map<number, BuildEvent>();
    let streaming = false;
    let lastSequence = 0;
    let closed = false;
    const terminal = (event: BuildEvent) => ["ready", "published", "failed"].includes(event.status);
    const writeLive = (event: BuildEvent) => {
      if (closed || event.sequence <= lastSequence) return;
      if (!streaming) {
        buffered.set(event.sequence, event);
        return;
      }
      lastSequence = event.sequence;
      reply.raw.write(sseEvent(event));
      if (terminal(event)) {
        closed = true;
        reply.raw.end();
      }
    };
    const unsubscribe = options.buildService?.subscribe(build.id, writeLive) ?? (() => {});
    const history = await options.store.listBuildEvents(admin.workspaceId, build.id, query.data);
    const replay = [...new Map([...history, ...buffered.values()]
      .map((event) => [event.sequence, event])).values()]
      .sort((left, right) => left.sequence - right.sequence);
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    if (query.data.once === "true" || !options.buildService || replay.some(terminal)) {
      unsubscribe();
      return reply.send(replay.map(sseEvent).join(""));
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    for (const event of replay) {
      if (event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      reply.raw.write(sseEvent(event));
    }
    streaming = true;
    for (const event of [...buffered.values()].sort((left, right) => left.sequence - right.sequence)) {
      writeLive(event);
    }
    buffered.clear();
    request.raw.on("close", () => {
      closed = true;
      unsubscribe();
    });
  });

  server.get("/api/knowledge/search", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      q: z.string().trim().min(1).max(500),
      releaseId: z.string().max(100).optional()
    })
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid search query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return {
      results: await options.store.searchKnowledge(
        admin.workspaceId, repository.id, parsed.data.q, parsed.data.releaseId
      )
    };
  });

  server.get("/api/knowledge/metadata", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ releaseId: z.string().min(1) }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid metadata query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return options.store.knowledgeMetadata(admin.workspaceId, parsed.data.releaseId);
  });

  server.get("/api/knowledge/pages", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      releaseId: z.string().max(100).optional(),
      ...paginationQuerySchema
    }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid page query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const [pages, total] = await Promise.all([
      options.store.listKnowledgePages(admin.workspaceId, parsed.data.releaseId, parsed.data),
      options.store.countKnowledgePages(admin.workspaceId, parsed.data.releaseId)
    ]);
    return {
      pages,
      ...paginationMetadata(total, parsed.data.offset ?? 0, pages.length)
    };
  });

  server.get("/api/knowledge/pages/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const page = parsed.success
      ? await options.store.getKnowledgePage(admin.workspaceId, parsed.data.id)
      : null;
    if (!page) return sendError(reply, 404, "PAGE_NOT_FOUND", "Knowledge page was not found");
    return { page };
  });

  server.get("/api/knowledge/source", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      path: z.string().min(1).max(500),
      startLine: z.coerce.number().int().positive(),
      endLine: z.coerce.number().int().positive(),
      releaseId: z.string().optional()
    }).refine((value) =>
      value.endLine >= value.startLine && value.endLine - value.startLine + 1 <= 500
    )
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid source range");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const release = parsed.data.releaseId
      ? await options.store.getRelease(admin.workspaceId, parsed.data.releaseId)
      : await options.store.currentRelease(admin.workspaceId, repository.id);
    if (!release) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, release.snapshotId);
    const sourceFile = await options.store.findSourceFile(
      admin.workspaceId, release.snapshotId, parsed.data.path
    );
    if (!snapshot || !sourceFile) return sendError(reply, 404, "SOURCE_NOT_FOUND", "Source file was not found");
    const root = await fs.realpath(snapshot.storagePath);
    const candidate = await fs.realpath(path.resolve(root, parsed.data.path)).catch(() => null);
    if (!candidate || (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root)) {
      return sendError(reply, 400, "INVALID_SOURCE_PATH", "Source path is outside the snapshot");
    }
    const bytes = await fs.readFile(candidate);
    if (createHash("sha256").update(bytes).digest("hex") !== sourceFile.contentHash) {
      return sendError(reply, 409, "SOURCE_CHANGED", "Snapshot source no longer matches its citation");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return sendError(reply, 409, "SOURCE_INVALID", "Snapshot source is not valid UTF-8 text");
    }
    const lines = content.split(/\r?\n/);
    if (parsed.data.endLine > lines.length) {
      return sendError(reply, 400, "INVALID_SOURCE_RANGE", "Source range exceeds the file");
    }
    return {
      path: parsed.data.path,
      startLine: parsed.data.startLine,
      endLine: parsed.data.endLine,
      commitSha: snapshot.commitSha,
      blobHash: sourceFile.contentHash,
      content: lines.slice(parsed.data.startLine - 1, parsed.data.endLine).join("\n")
    };
  });

  server.post("/api/releases", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ buildId: z.string().min(1), version: z.string().trim().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid release draft");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    try {
      const release = await options.store.createReleaseDraft(
        admin.workspaceId, repository.id, parsed.data.buildId, parsed.data.version
      );
      return reply.code(201).send({ release });
    } catch (error) {
      return sendError(reply, 409, "RELEASE_NOT_READY", error instanceof Error ? error.message : "Release failed");
    }
  });

  server.post("/api/releases/:id/publish", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid release");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      return { release: await options.store.publishRelease(admin.workspaceId, parsed.data.id) };
    } catch (error) {
      return sendError(reply, 409, "PUBLISH_FAILED", error instanceof Error ? error.message : "Publish failed");
    }
  });

  server.get("/api/releases/current", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const release = await options.store.currentRelease(admin.workspaceId, repository.id);
    if (!release) return sendError(reply, 404, "RELEASE_NOT_FOUND", "No release is published");
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, release.snapshotId);
    return { release: { ...release, commitSha: snapshot?.commitSha ?? null } };
  });

  server.get("/api/releases/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1).max(100) }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid release");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const release = await options.store.getRelease(admin.workspaceId, parsed.data.id);
    if (!release) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, release.snapshotId);
    return { release: { ...release, commitSha: snapshot?.commitSha ?? null } };
  });

  server.get("/api/releases", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid pagination");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const [releases, total] = await Promise.all([
      options.store.listReleases(admin.workspaceId, repository.id, parsed.data),
      options.store.countReleases(admin.workspaceId, repository.id)
    ]);
    return {
      releases: await Promise.all(releases.map(async (release) => ({
        ...release,
        commitSha: (await options.store.findSnapshotById(admin.workspaceId, release.snapshotId))?.commitSha ?? null
      }))),
      ...paginationMetadata(total, parsed.data.offset ?? 0, releases.length)
    };
  });

  server.get("/api/feedback", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      status: z.enum(AGENT_FEEDBACK_STATUSES).optional(),
      ...paginationQuerySchema
    })
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback filter");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const [feedback, total] = await Promise.all([
      options.store.listFeedback(admin.workspaceId, parsed.data.status, parsed.data),
      options.store.countFeedback(admin.workspaceId, parsed.data.status)
    ]);
    return {
      feedback,
      ...paginationMetadata(total, parsed.data.offset ?? 0, feedback.length)
    };
  });

  server.patch("/api/feedback/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = z.object({ status: z.enum(AGENT_FEEDBACK_STATUSES) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback transition");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const feedback = await options.store.transitionFeedbackWithAudit(
        admin.workspaceId, params.data.id, body.data.status, admin.id
      );
      if (!feedback) return sendError(reply, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found");
      return { feedback };
    } catch (error) {
      if (error instanceof InvalidFeedbackTransitionError) {
        return sendError(reply, 409, "INVALID_FEEDBACK_TRANSITION", "Feedback transition is not allowed");
      }
      return sendError(reply, 500, "FEEDBACK_OPERATION_FAILED", "Feedback transition failed");
    }
  });

  server.post("/api/feedback/:id/rebuild", { preHandler: requireAdmin }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback rebuild");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const feedback = await options.store.getFeedback(admin.workspaceId, params.data.id);
    if (!feedback) return sendError(reply, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found");
    if (feedback.status !== "acknowledged") {
      return sendError(reply, 409, "FEEDBACK_NOT_ACKNOWLEDGED", "Feedback must be acknowledged first");
    }
    const repository = await options.store.currentRepository(admin.workspaceId);
    const release = repository
      ? await options.store.currentRelease(admin.workspaceId, repository.id)
      : null;
    const snapshot = release
      ? await options.store.findSnapshotById(admin.workspaceId, release.snapshotId)
      : null;
    if (!repository || !release || !snapshot) {
      return sendError(reply, 409, "UNPUBLISHED", "No published release can be rebuilt");
    }
    try {
      const result = await options.store.requestFeedbackRebuildWithAudit({
        workspaceId: admin.workspaceId,
        feedbackId: feedback.id,
        releaseId: release.id,
        actorId: admin.id,
        build: {
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          snapshotId: snapshot.id,
          snapshotPath: snapshot.storagePath,
          commitSha: snapshot.commitSha
        }
      });
      await options.buildService.enqueueBuild(result);
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof FeedbackNotAcknowledgedError) {
        return sendError(reply, 409, "FEEDBACK_NOT_ACKNOWLEDGED", "Feedback must be acknowledged first");
      }
      return sendError(reply, 500, "FEEDBACK_OPERATION_FAILED", "Feedback rebuild failed");
    }
  });

  const activeMcpServers = new Set<ReturnType<typeof createRegisteredMcpServer>>();
  server.addHook("onClose", async () => {
    await Promise.all([...activeMcpServers].map((mcp) => mcp.close()));
    activeMcpServers.clear();
  });

  server.all("/mcp", async (request, reply) => {
    const authorization = request.headers.authorization;
    const match = /^Bearer (\S+)$/i.exec(authorization ?? "");
    const token = match ? await authenticateMcpToken(options.store, match[1]) : null;
    if (!token) return sendError(reply, 401, "UNAUTHORIZED", "Invalid or revoked MCP token");
    const mcp = createRegisteredMcpServer({
      store: options.store,
      workspaceId: token.workspaceId,
      authorize: createMcpAuthorizationGuard(options.store, match![1]),
      onUnauthorized: () => {
        setImmediate(() => void mcp.close());
      }
    });
    activeMcpServers.add(mcp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await mcp.connect(transport);
    reply.hijack();
    reply.raw.once("finish", () => {
      activeMcpServers.delete(mcp);
      void mcp.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  return server;
}
