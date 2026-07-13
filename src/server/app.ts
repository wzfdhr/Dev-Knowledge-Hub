import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
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
  type RepositoryRecord,
  type TeamMemberRecord,
  type TeamRole,
  type ProjectRecord
} from "./persistence/store.js";
import { decryptSecret, encryptSecret } from "./security/crypto.js";
import { DirtyWorktreeError, syncRepository } from "./git/snapshot.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { createSessionToken, verifySessionToken } from "./security/session.js";
import { createCodexConnectionPack } from "./codex/connection-pack.js";
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
import {
  importZipArchive,
  MAX_UPLOAD_COMPRESSED_BYTES,
  UploadArchiveError
} from "./uploads/zip-import.js";
import {
  ResumableUploadError,
  ResumableUploadSessionManager
} from "./uploads/resumable-upload.js";

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
  }),
  z.object({
    kind: z.literal("upload"),
    name: z.string().trim().min(1)
  })
]);

const paginationQuerySchema = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
};

const teamRoleSchema = z.enum(["admin", "member", "reader"]);
const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
});
const memberSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(12),
  role: teamRoleSchema
});

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
  const kind = (repository as { kind: string }).kind;
  return {
    repository: {
      id: repository.id,
      projectId: repository.projectId,
      kind: repository.kind,
      name: repository.name,
      ...(kind === "local" ? { path: repository.localPath } : {}),
      ...(kind === "git"
        ? { url: repository.cloneUrl, hasCredential: repository.hasCredential }
        : {}),
      defaultBranch: repository.defaultBranch
    }
  };
}

function repositoryInput(
  input: z.infer<typeof repositorySchema>,
  masterKey: string
) {
  if (input.kind === "local" || input.kind === "upload") return input;
  return {
    kind: input.kind,
    name: input.name,
    url: input.url,
    ...(input.token ? { encryptedToken: encryptSecret(input.token, masterKey) } : {})
  };
}

function archivedRepositoryDto(repository: RepositoryRecord) {
  return {
    id: repository.id,
    name: repository.name,
    kind: repository.kind,
    archivedAt: repository.archivedAt
  };
}

function memberDto(member: TeamMemberRecord | AdminRecord) {
  return { id: member.id, email: member.email, role: member.role, createdAt: "createdAt" in member ? member.createdAt : undefined };
}

function projectDto(project: ProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt
  };
}

function roleAllows(role: TeamRole, minimum: TeamRole): boolean {
  const rank: Record<TeamRole, number> = { reader: 0, member: 1, admin: 2 };
  return rank[role] >= rank[minimum];
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
  const resumableUploads = new ResumableUploadSessionManager(
    path.join(options.dataDir, "upload-staging")
  );
  registerHttpSecurity(server, options.rateLimits ?? DEFAULT_RATE_LIMITS);
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  server.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    if (statusCode === 413) {
      if (/^\/api\/repositories\/(?:current|[^/]+)\/uploads$/.test(request.url.split("?", 1)[0])) {
        return sendError(reply, 413, "ZIP_TOO_LARGE", "ZIP exceeds the 500 MiB compressed limit");
      }
      return sendError(reply, 413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB");
    }
    request.log.error({ err: error }, "Request failed");
    return sendError(reply, statusCode, "REQUEST_FAILED", "Request failed");
  });
  void server.register(cookie);
  void server.register(multipart, {
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      fileSize: MAX_UPLOAD_COMPRESSED_BYTES
    }
  });
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

  async function requireRole(
    role: TeamRole,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    await requireAdmin(request, reply);
    if (reply.sent) return;
    if (!roleAllows((request as AuthenticatedRequest).sessionAdmin.role, role)) {
      sendError(reply, 403, "FORBIDDEN", "Insufficient workspace role");
    }
  }

  const requireAdministrator = (request: FastifyRequest, reply: FastifyReply) =>
    requireRole("admin", request, reply);

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
    return { authenticated: true, admin: { id: admin.id, email: admin.email, role: admin.role } };
  });

  server.delete("/api/session", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  server.get("/api/session", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return { authenticated: true, admin: { id: admin.id, email: admin.email, role: admin.role } };
  });

  server.post("/api/uploads/resumable", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      totalBytes: z.number().int().positive(),
      chunkSize: z.number().int().positive()
    }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid upload dimensions");
    try {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      return reply.code(201).send(await resumableUploads.create({ ...parsed.data, ownerId: admin.id }));
    } catch (error) {
      if (error instanceof ResumableUploadError) {
        return sendError(reply, 413, error.code, error.message);
      }
      request.log.error({ err: error }, "Resumable upload creation failed");
      return sendError(reply, 500, "UPLOAD_FAILED", "Unable to create upload session");
    }
  });

  server.get("/api/uploads/resumable/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid upload session");
    try {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      return await resumableUploads.status(parsed.data.id, admin.id);
    } catch (error) {
      if (error instanceof ResumableUploadError) {
        return sendError(reply, 404, error.code, error.message);
      }
      request.log.error({ err: error }, "Resumable upload status failed");
      return sendError(reply, 500, "UPLOAD_FAILED", "Unable to read upload session");
    }
  });

  server.put(
    "/api/uploads/resumable/:id/chunks/:index",
    { preHandler: requireAdmin, bodyLimit: 16 * 1024 * 1024 + 1024 },
    async (request, reply) => {
      const params = z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }).safeParse(request.params);
      const declaredSize = z.coerce.number().int().positive().safeParse(request.headers["x-upload-chunk-size"]);
      if (!params.success || !declaredSize.success || !Buffer.isBuffer(request.body)) {
        return sendError(reply, 400, "INVALID_UPLOAD", "Invalid upload chunk");
      }
      try {
        const admin = (request as AuthenticatedRequest).sessionAdmin;
        return await resumableUploads.uploadChunk(
          params.data.id,
          params.data.index,
          request.body,
          declaredSize.data,
          admin.id
        );
      } catch (error) {
        if (error instanceof ResumableUploadError) {
          const statusCode = error.code === "SESSION_NOT_FOUND" ? 404 : 409;
          return sendError(reply, statusCode, error.code, error.message);
        }
        request.log.error({ err: error }, "Resumable upload chunk failed");
        return sendError(reply, 500, "UPLOAD_FAILED", "Unable to save upload chunk");
      }
    }
  );

  server.post(
    "/api/projects/:projectId/uploads/resumable/:id/import",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = z.object({ projectId: z.uuid(), id: z.uuid() }).safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid upload import");
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const repository = await options.store.currentRepository(admin.workspaceId, params.data.projectId);
      if (!repository || repository.kind !== "upload") {
        return sendError(reply, 409, "UPLOAD_REPOSITORY_REQUIRED", "Project requires an upload source");
      }
      let finalizedPath: string | undefined;
      try {
        const finalized = await resumableUploads.finalize(params.data.id, admin.id);
        finalizedPath = finalized.path;
        const summary = await importZipArchive({
          archivePath: finalized.path,
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        reply.code(summary.unchanged ? 200 : 201);
        return {
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        };
      } catch (error) {
        if (error instanceof ResumableUploadError || error instanceof UploadArchiveError) {
          const statusCode = error instanceof ResumableUploadError
            ? (error.code === "SESSION_NOT_FOUND" ? 404 : 409)
            : (error.code === "COMPRESSED_SIZE_LIMIT" ? 413 : 400);
          return sendError(reply, statusCode, error.code, error.message);
        }
        request.log.error({ err: error }, "Resumable ZIP import failed");
        return sendError(reply, 500, "UPLOAD_FAILED", "Unable to import ZIP upload");
      } finally {
        if (finalizedPath) await resumableUploads.discard(params.data.id, admin.id).catch(() => undefined);
      }
    }
  );

  server.get("/api/projects", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const projects = await options.store.listProjects(admin.workspaceId, parsed.data);
    return { projects: projects.map(projectDto) };
  });

  server.post("/api/projects", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project details");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const project = await options.store.createProject(admin.workspaceId, parsed.data, admin.id);
    if (!project) return sendError(reply, 409, "PROJECT_EXISTS", "A project with this slug already exists");
    return reply.code(201).send({ project: projectDto(project) });
  });

  server.post("/api/projects/:projectId/repositories", { preHandler: requireAdministrator }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const parsed = repositorySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid project repository details");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const project = (await options.store.listProjects(admin.workspaceId, { limit: 100 }))
      .find((candidate) => candidate.id === params.data.projectId && candidate.archivedAt === null);
    if (!project) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const repository = await options.store.createRepositoryWithAudit(
      admin.workspaceId,
      repositoryInput(parsed.data, options.masterKey),
      admin.id,
      project.id
    );
    if (!repository) return sendError(reply, 409, "REPOSITORY_EXISTS", "Project already has a current repository");
    return reply.code(201).send(repositoryDto(repository));
  });

  server.get("/api/projects/:projectId/codex-connection", { preHandler: requireAdministrator }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const project = (await options.store.listProjects(admin.workspaceId, { limit: 100 }))
      .find((candidate) => candidate.id === params.data.projectId && candidate.archivedAt === null);
    if (!project) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const environmentVariable = `DEVKH_${project.slug.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_TOKEN`;
    const pack = createCodexConnectionPack({
      projectName: project.name,
      projectId: project.id,
      endpoint: `${request.protocol}://${request.host}/mcp`,
      environmentVariable
    });
    return { projectId: project.id, environmentVariable, ...pack };
  });

  server.get("/api/members", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid member query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const members = await options.store.listTeamMembers(admin.workspaceId, parsed.data);
    return { members: members.map(memberDto) };
  });

  server.post("/api/members", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = memberSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid member details");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const member = await options.store.createTeamMember(admin.workspaceId, {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role
    }, admin.id);
    if (!member) return sendError(reply, 409, "MEMBER_EXISTS", "A member with this email already exists");
    return reply.code(201).send({ member: memberDto(member) });
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

  server.post("/api/mcp/tokens", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(100), projectId: z.uuid().optional() }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const projects = await options.store.listProjects(admin.workspaceId, { limit: 100 });
    const project = parsed.data.projectId
      ? projects.find((candidate) => candidate.id === parsed.data.projectId && candidate.archivedAt === null)
      : projects.find((candidate) => candidate.archivedAt === null);
    if (!project) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const plaintext = generateMcpToken();
    try {
      const token = await options.store.createMcpTokenWithAudit({
        workspaceId: admin.workspaceId,
        projectId: project.id,
        name: parsed.data.name,
        tokenHash: hashMcpToken(plaintext),
        tokenPrefix: plaintext.slice(0, 12)
      }, admin.id);
      return reply.code(201).send({ ...sanitizedMcpToken(token), token: plaintext });
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token creation failed");
    }
  });

  server.get("/api/mcp/tokens", { preHandler: requireAdministrator }, async (request, reply) => {
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

  server.post("/api/mcp/tokens/:id/revoke", { preHandler: requireAdministrator }, async (request, reply) => {
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
    const input = repositoryInput(parsed.data, options.masterKey);
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

  server.post("/api/repositories/current/replace", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const parsed = repositorySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid repository connection");
    if (parsed.data.kind === "upload") {
      const candidate = await options.store.prepareUploadReplacementWithAudit(
        admin.workspaceId,
        parsed.data.name,
        admin.id
      );
      if (!candidate) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
      return reply.code(202).send({ ...repositoryDto(candidate), pendingUpload: true });
    }
    const repository = await options.store.switchRepositoryWithAudit(
      admin.workspaceId,
      repositoryInput(parsed.data, options.masterKey),
      admin.id
    );
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return reply.code(201).send(repositoryDto(repository));
  });

  server.get("/api/repositories/archived", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repositories = await options.store.listArchivedRepositories(admin.workspaceId);
    return { repositories: repositories.map(archivedRepositoryDto) };
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
        commitTimestamp: latest.commitTimestamp,
        fileCount: await options.store.countSnapshotFiles(latest.id)
      } : null
    };
  });

  server.post(
    "/api/repositories/current/uploads",
    {
      preHandler: requireAdmin,
      bodyLimit: MAX_UPLOAD_COMPRESSED_BYTES + 1024 * 1024
    },
    async (request, reply) => {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const repository = await options.store.currentRepository(admin.workspaceId);
      if (!repository || (repository as { kind: string }).kind !== "upload") {
        return sendError(
          reply,
          409,
          "UPLOAD_REPOSITORY_REQUIRED",
          "Connect and activate an upload repository before importing a ZIP snapshot"
        );
      }

      const requestDirectory = path.join(options.dataDir, "uploads", randomUUID());
      const archivePath = path.join(requestDirectory, "archive.zip");
      const cleanup = () => fs.rm(requestDirectory, { recursive: true, force: true });
      const uploadError = async (statusCode: number, code: string, message: string) => {
        await cleanup();
        return sendError(reply, statusCode, code, message);
      };
      await fs.mkdir(requestDirectory, { recursive: true, mode: 0o700 });
      try {
        let fileCount = 0;
        for await (const part of request.parts()) {
          if (part.type !== "file" || part.fieldname !== "file") {
            return uploadError(
              400,
              "INVALID_UPLOAD",
              "Provide exactly one ZIP file field named file"
            );
          }
          fileCount += 1;
          if (fileCount > 1) {
            return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
          }
          await pipeline(part.file, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) {
            return uploadError(
              413,
              "ZIP_TOO_LARGE",
              "ZIP exceeds the 500 MiB compressed limit"
            );
          }
        }
        if (fileCount !== 1) {
          return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
        }
        const summary = await importZipArchive({
          archivePath,
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        const response = {
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        };
        await cleanup();
        return reply.code(summary.unchanged ? 200 : 201).send(response);
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return uploadError(413, "ZIP_TOO_LARGE", "ZIP exceeds the 500 MiB compressed limit");
        }
        if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FIELDS_LIMIT") {
          return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
        }
        if (error instanceof UploadArchiveError) {
          if (error.code === "COMPRESSED_SIZE_LIMIT") {
            return uploadError(
              413,
              "ZIP_TOO_LARGE",
              "ZIP exceeds the 500 MiB compressed limit"
            );
          }
          return uploadError(400, error.code, error.message);
        }
        request.log.error({ err: error }, "ZIP upload failed");
        return uploadError(500, "UPLOAD_FAILED", "ZIP upload failed");
      } finally {
        await cleanup();
      }
    }
  );

  server.post(
    "/api/repositories/:repositoryId/uploads",
    {
      preHandler: requireAdmin,
      bodyLimit: MAX_UPLOAD_COMPRESSED_BYTES + 1024 * 1024
    },
    async (request, reply) => {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const parsed = z.object({ repositoryId: z.uuid() }).safeParse(request.params);
      if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid upload replacement");
      const candidates = await options.store.listArchivedRepositories(admin.workspaceId);
      const repository = candidates.find((candidate) =>
        candidate.id === parsed.data.repositoryId && candidate.kind === "upload"
      );
      if (!repository || await options.store.latestSnapshot(admin.workspaceId, repository.id)) {
        return sendError(reply, 404, "UPLOAD_REPLACEMENT_NOT_FOUND", "Upload replacement was not found");
      }

      const requestDirectory = path.join(options.dataDir, "uploads", randomUUID());
      const archivePath = path.join(requestDirectory, "archive.zip");
      let replacementActivated = false;
      const cleanup = () => fs.rm(requestDirectory, { recursive: true, force: true });
      const uploadError = async (statusCode: number, code: string, message: string) => {
        await cleanup();
        return sendError(reply, statusCode, code, message);
      };
      await fs.mkdir(requestDirectory, { recursive: true, mode: 0o700 });
      try {
        let fileCount = 0;
        for await (const part of request.parts()) {
          if (part.type !== "file" || part.fieldname !== "file") {
            return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file field named file");
          }
          fileCount += 1;
          if (fileCount > 1) return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
          await pipeline(part.file, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) {
            return uploadError(413, "ZIP_TOO_LARGE", "ZIP exceeds the 500 MiB compressed limit");
          }
        }
        if (fileCount !== 1) return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
        const summary = await importZipArchive({
          archivePath,
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        const activated = await options.store.activateUploadReplacementWithAudit(
          admin.workspaceId,
          repository.id,
          admin.id
        );
        if (!activated) {
          return uploadError(409, "UPLOAD_REPLACEMENT_NOT_FOUND", "Upload replacement was not found");
        }
        replacementActivated = true;
        await cleanup();
        reply.code(summary.unchanged ? 200 : 201);
        return {
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        };
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "COMPRESSED_SIZE_LIMIT") {
          return uploadError(413, "ZIP_TOO_LARGE", "ZIP exceeds the 500 MiB compressed limit");
        }
        if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FIELDS_LIMIT") {
          return uploadError(400, "INVALID_UPLOAD", "Provide exactly one ZIP file");
        }
        if (error instanceof UploadArchiveError) return uploadError(400, error.code, error.message);
        request.log.error({ err: error }, "ZIP replacement upload failed");
        return uploadError(500, "UPLOAD_FAILED", "ZIP upload failed");
      } finally {
        await cleanup();
        if (!replacementActivated) {
          await options.store.discardPendingUploadReplacement(admin.workspaceId, repository.id)
            .catch(() => undefined);
        }
      }
    }
  );

  server.post(
    "/api/repositories/:repositoryId/uploads/resumable/:id/import",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = z.object({ repositoryId: z.uuid(), id: z.uuid() }).safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid upload replacement");
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const candidates = await options.store.listArchivedRepositories(admin.workspaceId);
      const repository = candidates.find((candidate) =>
        candidate.id === params.data.repositoryId && candidate.kind === "upload"
      );
      if (!repository || await options.store.latestSnapshot(admin.workspaceId, repository.id)) {
        return sendError(reply, 404, "UPLOAD_REPLACEMENT_NOT_FOUND", "Upload replacement was not found");
      }

      let finalizedPath: string | undefined;
      let replacementActivated = false;
      try {
        const finalized = await resumableUploads.finalize(params.data.id, admin.id);
        finalizedPath = finalized.path;
        const summary = await importZipArchive({
          archivePath: finalized.path,
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        const activated = await options.store.activateUploadReplacementWithAudit(
          admin.workspaceId,
          repository.id,
          admin.id
        );
        if (!activated) {
          return sendError(reply, 409, "UPLOAD_REPLACEMENT_NOT_FOUND", "Upload replacement was not found");
        }
        replacementActivated = true;
        reply.code(summary.unchanged ? 200 : 201);
        return {
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        };
      } catch (error) {
        if (error instanceof ResumableUploadError || error instanceof UploadArchiveError) {
          const statusCode = error instanceof ResumableUploadError
            ? (error.code === "SESSION_NOT_FOUND" ? 404 : 409)
            : (error.code === "COMPRESSED_SIZE_LIMIT" ? 413 : 400);
          return sendError(reply, statusCode, error.code, error.message);
        }
        request.log.error({ err: error }, "Resumable ZIP replacement import failed");
        return sendError(reply, 500, "UPLOAD_FAILED", "Unable to import ZIP upload");
      } finally {
        if (finalizedPath) await resumableUploads.discard(params.data.id, admin.id).catch(() => undefined);
        if (!replacementActivated) {
          await options.store.discardPendingUploadReplacement(admin.workspaceId, repository.id)
            .catch(() => undefined);
        }
      }
    }
  );

  server.post(
    "/api/repositories/current/sync",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const repository = await options.store.currentRepository(admin.workspaceId);
      if (!repository) {
        return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
      }
      if (repository.kind === "upload") {
        return sendError(
          reply,
          409,
          "UPLOAD_IMPORT_REQUIRED",
          "Upload repositories receive new versions through ZIP import"
        );
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
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_INPUT", "Invalid release ID");
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
      projectId: token.projectId,
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
