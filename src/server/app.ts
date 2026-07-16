import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
import { MAX_IMPORT_TABLE_WORKBOOK_BYTES } from "../shared/import-filter.js";
import {
  FeedbackNotAcknowledgedError,
  InvalidFeedbackTransitionError,
  LastProjectAdminError,
  LastWorkspaceAdminError,
  type AdminRecord,
  type AppStore,
  type ProjectMemberRecord,
  type ReleaseRecord,
  type RepositoryRecord,
  type TeamMemberRecord,
  type TeamRole,
  type ProjectRecord
} from "./persistence/store.js";
import { decryptSecret, encryptSecret } from "./security/crypto.js";
import { DirtyWorktreeError, syncRepository } from "./git/snapshot.js";
import { GitEgressDeniedError } from "./security/egress-policy.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import {
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyRecoveryCode,
  verifyTotp
} from "./security/mfa.js";
import {
  createCsrfToken,
  createOpaqueSessionId,
  hashSessionId,
  SESSION_DURATION_SECONDS,
  verifyCsrfToken,
  verifySessionToken
} from "./security/session.js";
import { MemorySessionStore, type SessionStore } from "./security/session-store.js";
import { createCodexConnectionPack } from "./codex/connection-pack.js";
import type { BuildEvent, BuildService } from "./knowledge/build-service.js";
import { deriveChangeImpact } from "./knowledge/change-impact.js";
import { loadPublishedKnowledgeGraph } from "./knowledge/pipeline/graph-query.js";
import { exportKnowledgeGraph } from "./knowledge/pipeline/viz.js";
import { legacyBuildStatus } from "./knowledge/pipeline/contracts.js";
import {
  InvalidStageEventCursorError,
  parseLastStageEventId,
  stageSseEvent
} from "./knowledge/pipeline/events.js";
import {
  authenticateMcpTokenDetailed,
  createMcpAuthorizationGuard,
  generateMcpToken,
  hashMcpToken,
  sanitizedMcpToken
} from "./mcp/auth.js";
import { MCP_TOKEN_SCOPES } from "./persistence/store.js";
import { createRegisteredMcpServer, MCP_TOOL_NAMES } from "./mcp/tools.js";
import {
  DEFAULT_RATE_LIMITS,
  MAX_REQUEST_BODY_BYTES,
  registerHttpSecurity,
  type RateLimitPolicy
} from "./security/http.js";
import {
  FolderUploadError,
  importFolderFiles,
  MAX_FOLDER_UPLOAD_FILES,
  type FolderUploadFile
} from "./uploads/folder-import.js";

const SESSION_COOKIE = "devkh_session";
const CSRF_COOKIE = "devkh_csrf";
const SESSION_MAX_AGE = 8 * 60 * 60;
const CSP_NONCE_PLACEHOLDER = "<!-- devkh:csp-nonce -->";
const MAX_STAGE_SSE_CONNECTIONS_PER_USER = 3;

const credentialsSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(12)
});
const loginSchema = credentialsSchema.extend({
  code: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().min(8).max(64).optional()
}).refine((value) => !(value.code && value.recoveryCode), "Provide one MFA factor");
const mfaEnrollmentSchema = z.object({ currentPassword: z.string().min(12) });
const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const mfaDisableSchema = z.object({ currentPassword: z.string().min(12), code: z.string().regex(/^\d{6}$/) });

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
const memberPasswordSchema = z.object({ password: z.string().min(12) });
const memberDisabledSchema = z.object({ disabled: z.boolean() });
const projectMemberSchema = z.object({ userId: z.uuid(), role: teamRoleSchema });
const projectMemberRoleSchema = z.object({ role: teamRoleSchema });

const PROJECT_ACTIVITY_METADATA_KEYS = new Set([
  "buildId",
  "code",
  "commitSha",
  "kind",
  "model",
  "newRepositoryId",
  "oldRepositoryId",
  "provider",
  "releaseId",
  "replacementTokenId",
  "role",
  "status",
  "unchanged"
]);

function projectActivityMetadata(metadata: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  return Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) =>
    PROJECT_ACTIVITY_METADATA_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
      ? [[key, value]]
      : []
  ));
}

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
  publicBaseUrl?: string;
  sessionStore?: SessionStore;
  legacySessionReadUntil?: Date;
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

function memberDto(member: TeamMemberRecord | ProjectMemberRecord | AdminRecord) {
  return {
    id: member.id,
    email: member.email,
    role: member.role,
    createdAt: "createdAt" in member ? member.createdAt : undefined,
    disabledAt: "disabledAt" in member ? member.disabledAt : null
  };
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

function importReportDto(report: Awaited<ReturnType<AppStore["listImportReports"]>>[number]) {
  return {
    id: report.id,
    projectId: report.projectId,
    repositoryId: report.repositoryId,
    sourceKind: report.sourceKind,
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    collectedFileCount: report.collectedFileCount,
    collectedTextBytes: report.collectedTextBytes,
    ignored: report.ignored,
    snapshotId: report.snapshotId,
    failureCode: report.failureCode
  };
}

function roleAllows(role: TeamRole, minimum: TeamRole): boolean {
  const rank: Record<TeamRole, number> = { reader: 0, member: 1, admin: 2 };
  return rank[role] >= rank[minimum];
}

function requestedProjectId(request: FastifyRequest): string | undefined {
  const value = request.headers["x-devkh-project"];
  return typeof value === "string" && z.uuid().safeParse(value).success ? value : undefined;
}

async function* directFolderParts(request: FastifyRequest): AsyncGenerator<FolderUploadFile> {
  for await (const part of request.parts({
    limits: {
      files: MAX_FOLDER_UPLOAD_FILES,
      fields: 0,
      parts: MAX_FOLDER_UPLOAD_FILES,
      fileSize: MAX_IMPORT_TABLE_WORKBOOK_BYTES
    }
  })) {
    if (part.type !== "file" || part.fieldname !== "files" || !part.filename) {
      throw new FolderUploadError("UNSAFE_FOLDER_PATH", "Folder uploads require file parts named files");
    }
    const content = await part.toBuffer();
    if (part.file.truncated) {
      throw new FolderUploadError("FOLDER_SIZE_LIMIT", "Folder upload contains a file larger than 50 MiB");
    }
    yield { path: part.filename, content };
  }
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
  const sessionStore = options.sessionStore ?? new MemorySessionStore();
  const stageSseConnections = new Map<string, number>();
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
    if (statusCode === 413) return sendError(reply, 413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB");
    request.log.error({ err: error }, "Request failed");
    return sendError(reply, statusCode, "REQUEST_FAILED", "Request failed");
  });
  void server.register(cookie);
  void server.register(multipart, {
    preservePath: true,
    limits: {
      files: MAX_FOLDER_UPLOAD_FILES,
      fields: 0,
      parts: MAX_FOLDER_UPLOAD_FILES,
      fileSize: MAX_IMPORT_TABLE_WORKBOOK_BYTES
    }
  });
  if (options.clientDir) {
    const clientEntrypointPath = (entrypoint: "react" | "vue") => entrypoint === "vue"
      ? path.join(options.clientDir!, "console-vue", "index.html")
      : path.join(options.clientDir!, "index.html");
    void server.register(fastifyStatic, { root: options.clientDir, index: false });
    server.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && request.url !== "/mcp") {
        const pathname = new URL(request.url, "http://devkh.local").pathname;
        const entrypoint = pathname === "/console-vue" || pathname.startsWith("/console-vue/") ? "vue" : "react";
        return fs.readFile(clientEntrypointPath(entrypoint), "utf8").then((html) => {
          if (!html.includes(CSP_NONCE_PLACEHOLDER)) throw new Error("Client entrypoint is missing CSP nonce placeholder");
          const page = html.replace(
            CSP_NONCE_PLACEHOLDER,
            `<meta name="devkh-csp-nonce" content="${request.cspNonce}" />`
          );
          return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(page);
        });
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
  const csrfCookieOptions = { ...cookieOptions, httpOnly: false, sameSite: "strict" as const };

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) {
      sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    try {
      const session = await sessionStore.findActive(hashSessionId(sessionId));
      if (session) {
        const admin = await options.store.findAdminById(session.userId, session.workspaceId);
        if (!admin || admin.disabledAt || admin.sessionVersion !== session.sessionVersion) {
          throw new Error("Unknown session administrator");
        }
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          const csrfCookie = request.cookies[CSRF_COOKIE];
          const csrfHeader = request.headers["x-devkh-csrf"];
          if (!csrfCookie || typeof csrfHeader !== "string" || csrfHeader !== csrfCookie
            || verifyCsrfToken(csrfHeader, sessionId, options.sessionSecret) !== session.csrfSecretHash) {
            sendError(reply, 403, "CSRF_INVALID", "CSRF token is missing or invalid");
            return;
          }
        }
        (request as AuthenticatedRequest).sessionAdmin = admin;
        return;
      }

      if (options.legacySessionReadUntil && options.legacySessionReadUntil > new Date()) {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          sendError(reply, 401, "SESSION_REFRESH_REQUIRED", "Please sign in again to continue");
          return;
        }
        const legacy = await verifySessionToken(sessionId, options.sessionSecret);
        const admin = await options.store.findAdminById(legacy.adminId, legacy.workspaceId);
        if (!admin || admin.disabledAt || admin.sessionVersion !== legacy.sessionVersion) {
          throw new Error("Unknown legacy session administrator");
        }
        (request as AuthenticatedRequest).sessionAdmin = admin;
        return;
      }

      throw new Error("Unknown session");
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
  const requireContributor = (request: FastifyRequest, reply: FastifyReply) =>
    requireRole("member", request, reply);

  async function requireProjectRole(
    role: TeamRole,
    projectId: string,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    await requireAdmin(request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const access = await options.store.projectAccess(admin.workspaceId, projectId, admin.id);
    if (!access || !access.role || !roleAllows(access.role, role)) {
      sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Insufficient project role");
    }
  }

  async function requireRepositoryRole(
    role: TeamRole,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<RepositoryRecord | null> {
    await requireAdmin(request, reply);
    if (reply.sent) return null;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId, requestedProjectId(request));
    if (!repository) {
      sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
      return null;
    }
    await requireProjectRole(role, repository.projectId, request, reply);
    return reply.sent ? null : repository;
  }

  async function currentRepositoryForRead(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<RepositoryRecord | null> {
    await requireAdmin(request, reply);
    if (reply.sent) return null;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(
      admin.workspaceId,
      requestedProjectId(request)
    );
    if (repository) await requireProjectRole("reader", repository.projectId, request, reply);
    return reply.sent ? null : repository;
  }

  async function requireReleaseProjectRole(
    role: TeamRole,
    releaseId: string | null,
    request: FastifyRequest,
    reply: FastifyReply,
    notFoundCode: string
  ): Promise<{ repository: RepositoryRecord; release: ReleaseRecord } | null> {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const release = releaseId ? await options.store.getRelease(admin.workspaceId, releaseId) : null;
    const repository = release
      ? await options.store.getRepository(admin.workspaceId, release.repositoryId)
      : null;
    if (!release || !repository) {
      sendError(reply, 404, notFoundCode, "The requested record was not found");
      return null;
    }
    await requireProjectRole(role, repository.projectId, request, reply);
    return reply.sent ? null : { repository, release };
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
    const parsed = loginSchema.safeParse(request.body);
    const workspace = await options.store.defaultWorkspace();
    const credentials = parsed.success && parsed.data ? parsed.data : null;
    const admin = credentials ? await options.store.findAdminByEmail(credentials.email) : null;
    const valid = credentials && admin && !admin.disabledAt
      ? await verifyPassword(admin.passwordHash, credentials.password)
      : false;

    if (!credentials || !valid || !admin) {
      if (workspace) {
        void options.store.recordAudit({
          workspaceId: workspace.id,
          action: "session.login_failed",
          resourceType: "session",
          metadata: { email: credentials?.email ?? "invalid" }
        }).catch(() => undefined);
      }
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const mfa = await options.store.getAdminMfa(admin.workspaceId, admin.id);
    if (mfa?.enabledAt) {
      if (mfa.lockedUntil && mfa.lockedUntil > new Date()) {
        return sendError(reply, 429, "MFA_LOCKED", "MFA is temporarily locked after repeated failed attempts");
      }
      let mfaValid = false;
      if (credentials.code) {
        mfaValid = verifyTotp(credentials.code, decryptSecret(mfa.encryptedSecret, options.masterKey));
      } else if (credentials.recoveryCode) {
        const candidates = await options.store.listActiveAdminMfaRecoveryCodes(admin.workspaceId, admin.id);
        for (const candidate of candidates) {
          if (await verifyRecoveryCode(credentials.recoveryCode, candidate.codeHash)) {
            mfaValid = await options.store.consumeAdminMfaRecoveryCode(admin.workspaceId, admin.id, candidate.id);
            break;
          }
        }
      } else {
        return sendError(reply, 401, "MFA_REQUIRED", "MFA verification is required");
      }
      if (!mfaValid) {
        const failure = await options.store.recordAdminMfaFailure(admin.workspaceId, admin.id);
        return sendError(
          reply,
          failure?.lockedUntil && failure.lockedUntil > new Date() ? 429 : 401,
          failure?.lockedUntil && failure.lockedUntil > new Date() ? "MFA_LOCKED" : "INVALID_MFA_CODE",
          "Invalid MFA verification code"
        );
      }
      await options.store.clearAdminMfaFailures(admin.workspaceId, admin.id);
    }

    const sessionId = createOpaqueSessionId();
    const csrf = createCsrfToken(sessionId, options.sessionSecret);
    await sessionStore.create({
      idHash: hashSessionId(sessionId), userId: admin.id, workspaceId: admin.workspaceId, csrfSecretHash: csrf.nonceHash,
      sessionVersion: admin.sessionVersion, expiresAt: new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000), revokedAt: null
    });
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions);
    reply.setCookie(CSRF_COOKIE, csrf.token, csrfCookieOptions);
    void options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "session.login_succeeded",
      resourceType: "session"
    }).catch(() => undefined);
    return { authenticated: true, admin: { id: admin.id, email: admin.email, role: admin.role } };
  });

  server.delete("/api/session", { preHandler: requireAdmin }, async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await sessionStore.revoke(hashSessionId(sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  server.get("/api/session", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return { authenticated: true, admin: { id: admin.id, email: admin.email, role: admin.role } };
  });

  server.post("/api/settings/mfa/enroll", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = mfaEnrollmentSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MFA enrollment request");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    if (!await verifyPassword(admin.passwordHash, parsed.data.currentPassword)) {
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid credentials");
    }
    const secret = createTotpSecret();
    await options.store.savePendingAdminMfa(admin.workspaceId, admin.id, encryptSecret(secret, options.masterKey));
    await options.store.recordAudit({
      workspaceId: admin.workspaceId, actorId: admin.id, action: "mfa.enrollment_started", resourceType: "admin_mfa", resourceId: admin.id
    });
    return reply.code(201).send({ enabled: false, secret, otpauthUri: totpUri(admin.email, secret) });
  });

  server.get("/api/settings/mfa", { preHandler: requireAdministrator }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const mfa = await options.store.getAdminMfa(admin.workspaceId, admin.id);
    return {
      enabled: Boolean(mfa?.enabledAt),
      pending: Boolean(mfa && !mfa.enabledAt),
      lockedUntil: mfa?.lockedUntil?.toISOString() ?? null
    };
  });

  server.post("/api/settings/mfa/verify", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = mfaCodeSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MFA verification code");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const mfa = await options.store.getAdminMfa(admin.workspaceId, admin.id);
    if (!mfa || mfa.enabledAt) return sendError(reply, 409, "MFA_ENROLLMENT_NOT_FOUND", "No pending MFA enrollment was found");
    if (!verifyTotp(parsed.data.code, decryptSecret(mfa.encryptedSecret, options.masterKey))) {
      await options.store.recordAdminMfaFailure(admin.workspaceId, admin.id);
      return sendError(reply, 401, "INVALID_MFA_CODE", "Invalid MFA verification code");
    }
    const recoveryCodes = createRecoveryCodes();
    const enabled = await options.store.enableAdminMfa(
      admin.workspaceId, admin.id, await Promise.all(recoveryCodes.map(hashRecoveryCode)), admin.id
    );
    if (!enabled) return sendError(reply, 409, "MFA_ENROLLMENT_NOT_FOUND", "No pending MFA enrollment was found");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { enabled: true, recoveryCodes };
  });

  server.delete("/api/settings/mfa", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = mfaDisableSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MFA disable request");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const mfa = await options.store.getAdminMfa(admin.workspaceId, admin.id);
    if (!mfa?.enabledAt) return sendError(reply, 404, "MFA_NOT_ENABLED", "MFA is not enabled");
    if (!await verifyPassword(admin.passwordHash, parsed.data.currentPassword)
      || !verifyTotp(parsed.data.code, decryptSecret(mfa.encryptedSecret, options.masterKey))) {
      return sendError(reply, 401, "INVALID_MFA_CODE", "Invalid MFA verification code");
    }
    if (!await options.store.disableAdminMfa(admin.workspaceId, admin.id, admin.id)) {
      return sendError(reply, 404, "MFA_NOT_ENABLED", "MFA is not enabled");
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  server.post(
    "/api/projects/:projectId/folder-import",
    { preHandler: requireContributor },
    async (request, reply) => {
      const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid project folder upload");
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      await requireProjectRole("member", params.data.projectId, request, reply);
      if (reply.sent) return;
      const repository = await options.store.currentRepository(admin.workspaceId, params.data.projectId);
      if (!repository || repository.kind !== "upload") {
        return sendError(reply, 409, "UPLOAD_REPOSITORY_REQUIRED", "Project requires a folder upload source");
      }
      const report = await options.store.createImportReport({
        workspaceId: admin.workspaceId,
        projectId: params.data.projectId,
        repositoryId: repository.id,
        actorId: admin.id,
        sourceKind: repository.kind
      });
      try {
        const summary = await importFolderFiles({
          files: directFolderParts(request),
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        await options.store.finishImportReport(admin.workspaceId, report.id, {
          status: "succeeded",
          collectedFileCount: summary.fileCount,
          collectedTextBytes: summary.textBytes,
          ignored: summary.ignored,
          snapshotId: summary.snapshotId,
          failureCode: null
        });
        return reply.code(summary.unchanged ? 200 : 201).send({
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        });
      } catch (error) {
        const code = error instanceof FolderUploadError ? error.code : "UPLOAD_FAILED";
        await options.store.finishImportReport(admin.workspaceId, report.id, {
          status: "failed",
          collectedFileCount: 0,
          collectedTextBytes: 0,
          ignored: { total: 0, reasons: {} },
          snapshotId: null,
          failureCode: code
        }).catch(() => undefined);
        if (error instanceof FolderUploadError) {
          const statusCode = error.code === "FOLDER_SIZE_LIMIT" || error.code === "TOO_MANY_FILES" ? 413 : 400;
          return sendError(reply, statusCode, error.code, error.message);
        }
        request.log.error({ err: error }, "Folder import failed");
        return sendError(reply, 500, "UPLOAD_FAILED", "Unable to import project folder");
      }
    }
  );

  server.post(
    "/api/repositories/:repositoryId/folder-import",
    { preHandler: requireContributor },
    async (request, reply) => {
      const params = z.object({ repositoryId: z.uuid() }).safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "INVALID_UPLOAD", "Invalid replacement folder upload");
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const candidates = await options.store.listArchivedRepositories(admin.workspaceId);
      const repository = candidates.find((candidate) => candidate.id === params.data.repositoryId && candidate.kind === "upload");
      if (!repository || await options.store.latestSnapshot(admin.workspaceId, repository.id)) {
        return sendError(reply, 404, "UPLOAD_REPLACEMENT_NOT_FOUND", "Folder upload replacement was not found");
      }
      await requireProjectRole("admin", repository.projectId, request, reply);
      if (reply.sent) return;
      const report = await options.store.createImportReport({
        workspaceId: admin.workspaceId,
        projectId: repository.projectId,
        repositoryId: repository.id,
        actorId: admin.id,
        sourceKind: repository.kind
      });
      let activated = false;
      try {
        const summary = await importFolderFiles({
          files: directFolderParts(request),
          dataDir: options.dataDir,
          workspaceId: admin.workspaceId,
          repositoryId: repository.id,
          actorId: admin.id,
          store: options.store
        });
        const replacement = await options.store.activateUploadReplacementWithAudit(admin.workspaceId, repository.id, admin.id);
        if (!replacement) return sendError(reply, 409, "UPLOAD_REPLACEMENT_NOT_FOUND", "Folder upload replacement was not found");
        activated = true;
        await options.store.finishImportReport(admin.workspaceId, report.id, {
          status: "succeeded",
          collectedFileCount: summary.fileCount,
          collectedTextBytes: summary.textBytes,
          ignored: summary.ignored,
          snapshotId: summary.snapshotId,
          failureCode: null
        });
        return reply.code(summary.unchanged ? 200 : 201).send({
          snapshotId: summary.snapshotId,
          sourceVersion: summary.sourceVersion,
          fileCount: summary.fileCount,
          unchanged: summary.unchanged,
          ignored: summary.ignored
        });
      } catch (error) {
        const code = error instanceof FolderUploadError ? error.code : "UPLOAD_FAILED";
        await options.store.finishImportReport(admin.workspaceId, report.id, {
          status: "failed",
          collectedFileCount: 0,
          collectedTextBytes: 0,
          ignored: { total: 0, reasons: {} },
          snapshotId: null,
          failureCode: code
        }).catch(() => undefined);
        if (error instanceof FolderUploadError) {
          const statusCode = error.code === "FOLDER_SIZE_LIMIT" || error.code === "TOO_MANY_FILES" ? 413 : 400;
          return sendError(reply, statusCode, error.code, error.message);
        }
        request.log.error({ err: error }, "Folder replacement import failed");
        return sendError(reply, 500, "UPLOAD_FAILED", "Unable to import replacement folder");
      } finally {
        if (!activated) {
          await options.store.discardPendingUploadReplacement(admin.workspaceId, repository.id).catch(() => undefined);
        }
      }
    }
  );

  server.get("/api/projects", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const projects = await options.store.listAccessibleProjects(admin.workspaceId, admin.id, parsed.data);
    return { projects: projects.map(projectDto) };
  });

  server.get("/api/workspace/overview", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const records = await options.store.workspaceOverview(admin.workspaceId, admin.id);
    const summaries = records.map((record) => ({
      project: projectDto(record.project),
      repository: record.repository ? repositoryDto(record.repository).repository : null,
      latestSnapshot: record.latestSnapshot ? {
        id: record.latestSnapshot.id,
        commitSha: record.latestSnapshot.commitSha,
        ref: record.latestSnapshot.ref,
        commitTimestamp: record.latestSnapshot.commitTimestamp,
        fileCount: record.latestSnapshot.fileCount
      } : null,
      indexedTextBytes: record.indexedTextBytes,
      currentRelease: record.currentRelease,
      latestBuild: record.latestBuild,
      memberCount: record.memberCount,
      pendingFeedbackCount: record.pendingFeedbackCount
    }));
    const members = await options.store.countTeamMembers(admin.workspaceId);
    return {
      projects: summaries,
      totals: {
        projects: summaries.length,
        connected: summaries.filter((item) => item.repository).length,
        published: summaries.filter((item) => item.currentRelease).length,
        members
      }
    };
  });

  server.get("/api/workspace/knowledge/search", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().min(1).max(500) }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid search query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const results = await options.store.searchWorkspaceKnowledge(admin.workspaceId, admin.id, parsed.data.q);
    return { results: results.map(({ project, ...result }) => ({
      ...result, projectId: project.id, projectName: project.name, projectSlug: project.slug
    })) };
  });

  server.post("/api/projects", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project details");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const project = await options.store.createProject(admin.workspaceId, parsed.data, admin.id);
    if (!project) return sendError(reply, 409, "PROJECT_EXISTS", "A project with this slug already exists");
    return reply.code(201).send({ project: projectDto(project) });
  });

  server.get("/api/projects/:projectId/summary", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const access = await options.store.projectAccess(admin.workspaceId, params.data.projectId, admin.id);
    if (!access || access.project.archivedAt !== null) {
      return sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Insufficient project role");
    }
    const project = access.project;
    const [repository, members] = await Promise.all([
      options.store.currentRepository(admin.workspaceId, project.id),
      options.store.listProjectMembers(admin.workspaceId, project.id, { limit: 100 })
    ]);
    const memberCount = members.length;
    if (!repository) {
      return {
        project: projectDto(project), repository: null, latestSnapshot: null,
        currentRelease: null, latestBuild: null, memberCount
      };
    }
    const [latestSnapshot, currentRelease, latestBuilds] = await Promise.all([
      options.store.latestSnapshot(admin.workspaceId, repository.id),
      options.store.currentRelease(admin.workspaceId, repository.id),
      options.store.listBuilds(admin.workspaceId, repository.id, { limit: 1 })
    ]);
    const fileCount = latestSnapshot
      ? await options.store.countSnapshotFiles(latestSnapshot.id)
      : 0;
    return {
      project: projectDto(project),
      repository: repositoryDto(repository).repository,
      latestSnapshot: latestSnapshot ? {
        id: latestSnapshot.id,
        commitSha: latestSnapshot.commitSha,
        ref: latestSnapshot.ref,
        commitTimestamp: latestSnapshot.commitTimestamp,
        fileCount
      } : null,
      currentRelease,
      latestBuild: latestBuilds[0] ?? null,
      memberCount
    };
  });

  server.get("/api/projects/:projectId/activity", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!params.success || !parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid project activity query");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const access = await options.store.projectAccess(admin.workspaceId, params.data.projectId, admin.id);
    if (!access || access.project.archivedAt !== null) {
      return sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Insufficient project role");
    }
    const project = access.project;
    const [activity, total, members] = await Promise.all([
      options.store.listProjectActivity(admin.workspaceId, project.id, parsed.data),
      options.store.countProjectActivity(admin.workspaceId, project.id),
      options.store.listProjectMembers(admin.workspaceId, project.id, { limit: 100 })
    ]);
    const actorEmails = new Map(members.map((member) => [member.id, member.email]));
    return {
      activity: activity.map((event) => ({
        id: event.id,
        projectId: project.id,
        actorId: event.actorId ?? null,
        actorEmail: event.actorId ? actorEmails.get(event.actorId) ?? null : null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        metadata: projectActivityMetadata(event.metadata),
        createdAt: event.createdAt
      })),
      members: members.map(memberDto),
      ...paginationMetadata(total, parsed.data.offset ?? 0, activity.length)
    };
  });

  server.get("/api/projects/:projectId/import-reports", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!params.success || !parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid import report query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const access = await options.store.projectAccess(admin.workspaceId, params.data.projectId, admin.id);
    if (!access || access.project.archivedAt !== null) {
      return sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Insufficient project role");
    }
    const [reports, total] = await Promise.all([
      options.store.listImportReports(admin.workspaceId, params.data.projectId, parsed.data),
      options.store.countImportReports(admin.workspaceId, params.data.projectId)
    ]);
    return { reports: reports.map(importReportDto), ...paginationMetadata(total, parsed.data.offset ?? 0, reports.length) };
  });

  server.get("/api/projects/:projectId/changes", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId, params.data.projectId);
    if (!repository) return { change: null };
    const snapshot = await options.store.latestSnapshot(admin.workspaceId, repository.id);
    const change = snapshot
      ? await options.store.snapshotChangeSummary(admin.workspaceId, repository.id, snapshot.id)
      : null;
    if (!change) return { change: null };
    const release = await options.store.currentRelease(admin.workspaceId, repository.id);
    const metadata = release ? await options.store.knowledgeMetadata(admin.workspaceId, release.id) : null;
    const graph = release
      ? await options.store.getKnowledgeGraph(admin.workspaceId, params.data.projectId, release.buildId)
      : null;
    return {
      change: release
        ? deriveChangeImpact(change, metadata!, graph)
        : change
    };
  });

  server.get("/api/projects/:projectId/graph", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const query = z.object({
      releaseId: z.uuid().optional(),
      format: z.enum(["json", "tree", "mermaid", "markmap"]).default("json")
    }).safeParse(request.query);
    if (!params.success || !query.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid graph query");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId, params.data.projectId);
    if (!repository) return { release: null, format: query.data.format, data: null };
    const selected = await loadPublishedKnowledgeGraph({
      store: options.store,
      workspaceId: admin.workspaceId,
      projectId: params.data.projectId,
      repositoryId: repository.id,
      releaseId: query.data.releaseId
    });
    if (!selected) return { release: null, format: query.data.format, data: null };
    const graph = exportKnowledgeGraph(selected.graph);
    const data = query.data.format === "mermaid"
      ? graph.mermaid
      : query.data.format === "markmap"
        ? graph.markmap
        : query.data.format === "tree"
          ? graph.tree
          : graph.graph;
    return { release: selected.release, format: query.data.format, data };
  });

  server.get("/api/projects/:projectId/knowledge-quality", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const overview = (await options.store.workspaceOverview(admin.workspaceId, admin.id))
      .find((entry) => entry.project.id === params.data.projectId);
    if (!overview) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const repository = overview.repository;
    const snapshot = overview.latestSnapshot;
    const release = overview.currentRelease;
    const change = repository && snapshot
      ? await options.store.snapshotChangeSummary(admin.workspaceId, repository.id, snapshot.id)
      : null;
    const metadata = release
      ? await options.store.knowledgeMetadata(admin.workspaceId, release.id)
      : null;
    const graph = release
      ? await options.store.getKnowledgeGraph(admin.workspaceId, params.data.projectId, release.buildId)
      : null;
    const enrichedChange = change && metadata ? deriveChangeImpact(change, metadata, graph) : change;
    const knowledge = release
      ? await options.store.knowledgeReleaseSummary(admin.workspaceId, release.id)
      : { pageCount: 0, chunkCount: 0, citationCount: 0 };
    const remediationStates = ["open", "accepted", "rebuilding", "resolved", "dismissed"] as const;
    const remediationCounts = await Promise.all(remediationStates.map(async (state) => [
      state,
      await options.store.countRemediations(admin.workspaceId, params.data.projectId, state)
    ] as const));
    const remediation = Object.fromEntries(remediationCounts) as Record<(typeof remediationStates)[number], number>;
    const qualityRun = overview.latestBuild
      ? (await options.store.listPipelineStageRuns(
        admin.workspaceId, params.data.projectId, overview.latestBuild.id
      )).filter((run) => run.stage === "lint").at(-1)
      : undefined;
    const diagnostics: Array<{ code: string }> = [];
    if (!repository) diagnostics.push({ code: "SOURCE_MISSING" });
    else if (!snapshot) diagnostics.push({ code: "SNAPSHOT_MISSING" });
    else if (overview.latestBuild?.status === "failed") diagnostics.push({ code: "BUILD_FAILED" });
    else if (!release) diagnostics.push({ code: "RELEASE_MISSING" });
    else if (enrichedChange?.requiresBuild && release.snapshotId !== snapshot.id) diagnostics.push({ code: "REBUILD_RECOMMENDED" });
    else diagnostics.push({ code: "PUBLISHED" });
    return {
      repository,
      latestSnapshot: snapshot,
      currentRelease: release,
      latestBuild: overview.latestBuild,
      pendingFeedbackCount: overview.pendingFeedbackCount,
      indexedTextBytes: overview.indexedTextBytes,
      knowledge,
      remediation,
      qualityPipeline: qualityRun ? {
        status: qualityRun.status,
        artifactReady: qualityRun.outputManifestIds.length > 0,
        errorCode: qualityRun.errorCode
      } : null,
      change: enrichedChange,
      diagnostics
    };
  });

  server.get("/api/projects/:projectId/remediations", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const query = z.object(paginationQuerySchema).safeParse(request.query);
    if (!params.success || !query.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid remediation query");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const remediations = await options.store.listRemediations(
      admin.workspaceId, params.data.projectId, query.data
    );
    return { remediations };
  });

  server.get("/api/projects/:projectId/remediations/:remediationId/events", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid(), remediationId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid remediation event query");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const remediation = await options.store.getRemediation(admin.workspaceId, params.data.remediationId);
    if (!remediation || remediation.projectId !== params.data.projectId) {
      return sendError(reply, 404, "REMEDIATION_NOT_FOUND", "Remediation was not found");
    }
    return { events: await options.store.listRemediationEvents(admin.workspaceId, remediation.id) };
  });

  server.patch("/api/projects/:projectId/remediations/:remediationId", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid(), remediationId: z.uuid() }).safeParse(request.params);
    const body = z.object({ state: z.enum(["accepted", "dismissed", "resolved"]) }).safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid remediation transition");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const existing = await options.store.getRemediation(admin.workspaceId, params.data.remediationId);
    if (!existing || existing.projectId !== params.data.projectId) {
      return sendError(reply, 404, "REMEDIATION_NOT_FOUND", "Remediation was not found");
    }
    try {
      const remediation = await options.store.transitionRemediationWithAudit(
        admin.workspaceId, existing.id, body.data.state, admin.id
      );
      return { remediation };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid remediation transition:")) {
        return sendError(reply, 409, "INVALID_REMEDIATION_TRANSITION", "Remediation transition is not allowed");
      }
      return sendError(reply, 500, "REMEDIATION_OPERATION_FAILED", "Remediation transition failed");
    }
  });

  server.post("/api/projects/:projectId/remediations/:remediationId/rebuild", { preHandler: requireAdmin }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const params = z.object({ projectId: z.uuid(), remediationId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid remediation rebuild");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const remediation = await options.store.getRemediation(admin.workspaceId, params.data.remediationId);
    if (!remediation || remediation.projectId !== params.data.projectId) {
      return sendError(reply, 404, "REMEDIATION_NOT_FOUND", "Remediation was not found");
    }
    if (remediation.state !== "accepted") {
      return sendError(reply, 409, "REMEDIATION_NOT_ACCEPTED", "Remediation must be accepted first");
    }
    const sourceBuild = await options.store.getBuild(admin.workspaceId, remediation.sourceBuildId);
    const snapshot = sourceBuild
      ? await options.store.findSnapshotById(admin.workspaceId, sourceBuild.snapshotId)
      : null;
    if (!sourceBuild || sourceBuild.repositoryId !== remediation.repositoryId || !snapshot) {
      return sendError(reply, 409, "REMEDIATION_SOURCE_UNAVAILABLE", "Remediation source snapshot is unavailable");
    }
    try {
      const result = await options.store.requestRemediationBuildWithAudit({
        workspaceId: admin.workspaceId,
        remediationId: remediation.id,
        actorId: admin.id,
        build: {
          workspaceId: admin.workspaceId,
          repositoryId: remediation.repositoryId,
          snapshotId: snapshot.id,
          snapshotPath: snapshot.storagePath,
          commitSha: snapshot.commitSha
        }
      });
      await options.buildService.enqueueBuild(result);
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === "Remediation must be accepted first") {
        return sendError(reply, 409, "REMEDIATION_NOT_ACCEPTED", "Remediation must be accepted first");
      }
      return sendError(reply, 500, "REMEDIATION_OPERATION_FAILED", "Remediation rebuild failed");
    }
  });

  server.post("/api/projects/:projectId/repositories", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const parsed = repositorySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid project repository details");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const project = (await options.store.projectAccess(admin.workspaceId, params.data.projectId, admin.id))?.project;
    if (!project || project.archivedAt !== null) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const repository = await options.store.createRepositoryWithAudit(
      admin.workspaceId,
      repositoryInput(parsed.data, options.masterKey),
      admin.id,
      project.id
    );
    if (!repository) return sendError(reply, 409, "REPOSITORY_EXISTS", "Project already has a current repository");
    return reply.code(201).send(repositoryDto(repository));
  });

  server.get("/api/projects/:projectId/codex-connection", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const project = (await options.store.projectAccess(admin.workspaceId, params.data.projectId, admin.id))?.project;
    if (!project || project.archivedAt !== null) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const environmentVariable = `DEVKH_${project.slug.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_TOKEN`;
    const endpoint = `${(options.publicBaseUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, "")}/mcp`;
    const pack = createCodexConnectionPack({
      projectName: project.name,
      projectId: project.id,
      endpoint,
      environmentVariable
    });
    return { projectId: project.id, endpoint, environmentVariable, ...pack };
  });

  server.get("/api/projects/:projectId/members", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!params.success || !parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project member query");
    await requireProjectRole("reader", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const members = await options.store.listProjectMembers(admin.workspaceId, params.data.projectId, parsed.data);
    return { members: members.map(memberDto) };
  });

  server.get("/api/projects/:projectId/available-members", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const members = await options.store.listTeamMembers(admin.workspaceId, { limit: 100 });
    return { members: members.map(memberDto) };
  });

  server.post("/api/projects/:projectId/members", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const body = projectMemberSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project member");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const member = await options.store.addProjectMember(
      admin.workspaceId, params.data.projectId, body.data.userId, body.data.role, admin.id
    );
    if (!member) return sendError(reply, 409, "PROJECT_MEMBER_INVALID", "Member is unavailable for this project or role");
    return reply.code(201).send({ member: memberDto(member) });
  });

  server.patch("/api/projects/:projectId/members/:userId", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid(), userId: z.uuid() }).safeParse(request.params);
    const body = projectMemberRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project member role");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const member = await options.store.updateProjectMemberRole(
        admin.workspaceId, params.data.projectId, params.data.userId, body.data.role, admin.id
      );
      if (!member) return sendError(reply, 404, "PROJECT_MEMBER_NOT_FOUND", "Project member was not found");
      return { member: memberDto(member) };
    } catch (error) {
      if (error instanceof LastProjectAdminError) {
        return sendError(reply, 409, "LAST_PROJECT_ADMIN", "A project must retain an administrator");
      }
      throw error;
    }
  });

  server.delete("/api/projects/:projectId/members/:userId", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ projectId: z.uuid(), userId: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid project member");
    await requireProjectRole("admin", params.data.projectId, request, reply);
    if (reply.sent) return;
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const member = await options.store.removeProjectMember(
        admin.workspaceId, params.data.projectId, params.data.userId, admin.id
      );
      if (!member) return sendError(reply, 404, "PROJECT_MEMBER_NOT_FOUND", "Project member was not found");
      return { member: memberDto(member) };
    } catch (error) {
      if (error instanceof LastProjectAdminError) {
        return sendError(reply, 409, "LAST_PROJECT_ADMIN", "A project must retain an administrator");
      }
      throw error;
    }
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

  server.patch("/api/members/:userId/password", { preHandler: requireAdministrator }, async (request, reply) => {
    const params = z.object({ userId: z.uuid() }).safeParse(request.params);
    const body = memberPasswordSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid member password");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const member = await options.store.resetTeamMemberPassword(
      admin.workspaceId, params.data.userId, await hashPassword(body.data.password), admin.id
    );
    if (!member) return sendError(reply, 404, "MEMBER_NOT_FOUND", "Member was not found");
    return { member: memberDto(member) };
  });

  server.patch("/api/members/:userId/disabled", { preHandler: requireAdministrator }, async (request, reply) => {
    const params = z.object({ userId: z.uuid() }).safeParse(request.params);
    const body = memberDisabledSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid member status");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    if (params.data.userId === admin.id && body.data.disabled) {
      return sendError(reply, 409, "SELF_DISABLE_FORBIDDEN", "Administrators cannot disable their own account");
    }
    try {
      const member = await options.store.setTeamMemberDisabled(
        admin.workspaceId, params.data.userId, body.data.disabled, admin.id
      );
      if (!member) return sendError(reply, 404, "MEMBER_NOT_FOUND", "Member was not found");
      return { member: memberDto(member) };
    } catch (error) {
      if (error instanceof LastWorkspaceAdminError) {
        return sendError(reply, 409, "LAST_WORKSPACE_ADMIN", "A workspace must retain an active administrator");
      }
      throw error;
    }
  });

  const modelConfigDto = (config: Awaited<ReturnType<AppStore["getModelConfig"]>>) => ({
    config: config ? { provider: config.provider, model: config.model, hasApiKey: true } : null
  });

  server.get("/api/settings/model", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return modelConfigDto(await options.store.getModelConfig(admin.workspaceId));
  });

  server.put("/api/settings/model", { preHandler: requireAdministrator }, async (request, reply) => {
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
    const parsed = z.object({
      name: z.string().trim().min(1).max(100),
      projectId: z.uuid().optional(),
      scopes: z.array(z.enum(MCP_TOKEN_SCOPES)).min(1).max(MCP_TOKEN_SCOPES.length).optional()
    }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const projects = await options.store.listAccessibleProjects(admin.workspaceId, admin.id, { limit: 100 });
    const project = parsed.data.projectId
      ? projects.find((candidate) => candidate.id === parsed.data.projectId && candidate.archivedAt === null)
      : projects.find((candidate) => candidate.archivedAt === null);
    if (!project) return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project was not found");
    await requireProjectRole("admin", project.id, request, reply);
    if (reply.sent) return;
    const plaintext = generateMcpToken();
    try {
      const token = await options.store.createMcpTokenWithAudit({
        workspaceId: admin.workspaceId,
        projectId: project.id,
        name: parsed.data.name,
        tokenHash: hashMcpToken(plaintext),
        tokenPrefix: plaintext.slice(0, 12),
        scopes: parsed.data.scopes ?? [...MCP_TOKEN_SCOPES]
      }, admin.id);
      return reply.code(201).send({ ...sanitizedMcpToken(token), token: plaintext });
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token creation failed");
    }
  });

  server.get("/api/mcp/tokens", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ ...paginationQuerySchema, projectId: z.uuid().optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid pagination");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    if (!parsed.data.projectId && admin.role !== "admin") {
      return sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Choose a project to view its MCP tokens");
    }
    if (parsed.data.projectId) {
      await requireProjectRole("reader", parsed.data.projectId, request, reply);
      if (reply.sent) return;
    }
    const [tokens, total] = await Promise.all([
      options.store.listMcpTokens(admin.workspaceId, parsed.data, parsed.data.projectId),
      options.store.countMcpTokens(admin.workspaceId, parsed.data.projectId)
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
      const candidates = await options.store.listMcpTokens(admin.workspaceId, { limit: 100 });
      const candidate = candidates.find((token) => token.id === parsed.data.id);
      if (!candidate) return sendError(reply, 404, "TOKEN_NOT_FOUND", "MCP token was not found");
      await requireProjectRole("admin", candidate.projectId, request, reply);
      if (reply.sent) return;
      const token = await options.store.revokeMcpTokenWithAudit(
        admin.workspaceId, parsed.data.id, admin.id
      );
      if (!token) return sendError(reply, 404, "TOKEN_NOT_FOUND", "MCP token was not found");
      return { token: sanitizedMcpToken(token) };
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token revocation failed");
    }
  });

  server.post("/api/mcp/tokens/:id/rotate", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_MCP_TOKEN", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const candidates = await options.store.listMcpTokens(admin.workspaceId, { limit: 100 });
    const candidate = candidates.find((token) => token.id === parsed.data.id);
    if (!candidate) return sendError(reply, 404, "TOKEN_NOT_FOUND", "MCP token was not found");
    await requireProjectRole("admin", candidate.projectId, request, reply);
    if (reply.sent) return;
    const plaintext = generateMcpToken();
    try {
      const rotation = await options.store.rotateMcpTokenWithAudit(
        admin.workspaceId,
        candidate.id,
        { tokenHash: hashMcpToken(plaintext), tokenPrefix: plaintext.slice(0, 12), scopes: candidate.scopes },
        admin.id
      );
      if (!rotation) return sendError(reply, 409, "TOKEN_NOT_ACTIVE", "MCP token is already revoked");
      return {
        previous: sanitizedMcpToken(rotation.previous),
        replacement: sanitizedMcpToken(rotation.replacement),
        token: plaintext
      };
    } catch {
      return sendError(reply, 500, "TOKEN_OPERATION_FAILED", "MCP token rotation failed");
    }
  });

  server.get("/api/mcp/connection", { preHandler: requireAdmin }, async () => ({
    endpoint: "/mcp",
    transport: "streamable-http",
    authorization: "bearer",
    stdioCommand: "npm run mcp:stdio",
    tools: MCP_TOOL_NAMES
  }));

  server.post("/api/repositories", { preHandler: requireAdministrator }, async (request, reply) => {
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
    const current = await requireRepositoryRole("admin", request, reply);
    if (!current) return;
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

  server.get("/api/repositories/archived", { preHandler: requireAdministrator }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repositories = await options.store.listArchivedRepositories(admin.workspaceId);
    return { repositories: repositories.map(archivedRepositoryDto) };
  });

  server.get("/api/repositories/current", { preHandler: requireAdmin }, async (request, reply) => {
    const repository = await currentRepositoryForRead(request, reply);
    if (reply.sent) return;
    return repository ? repositoryDto(repository) : { repository: null };
  });

  server.get("/api/repositories/current/status", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await currentRepositoryForRead(request, reply);
    if (reply.sent) return;
    if (!repository) return { repository: null, latestSnapshot: null };
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
    "/api/repositories/current/sync",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const admin = (request as AuthenticatedRequest).sessionAdmin;
      const repository = await requireRepositoryRole("member", request, reply);
      if (!repository) return;
      if (repository.kind === "upload") {
        return sendError(
          reply,
          409,
          "UPLOAD_IMPORT_REQUIRED",
          "Upload repositories receive new versions through folder import"
        );
      }
      const importReport = await options.store.createImportReport({
        workspaceId: admin.workspaceId,
        projectId: repository.projectId,
        repositoryId: repository.id,
        actorId: admin.id,
        sourceKind: repository.kind
      });
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
        await options.store.finishImportReport(admin.workspaceId, importReport.id, {
          status: "succeeded",
          collectedFileCount: summary.fileCount,
          collectedTextBytes: summary.textBytes,
          ignored: summary.ignored,
          snapshotId: summary.snapshotId,
          failureCode: null
        });
        return summary;
      } catch (error) {
        const code = error instanceof DirtyWorktreeError || error instanceof GitEgressDeniedError ? error.code : "SYNC_FAILED";
        await options.store.finishImportReport(admin.workspaceId, importReport.id, {
          status: "failed",
          collectedFileCount: 0,
          collectedTextBytes: 0,
          ignored: { total: 0, reasons: {} },
          snapshotId: null,
          failureCode: code
        }).catch(() => undefined);
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
        if (error instanceof GitEgressDeniedError) {
          return sendError(reply, 400, error.code, error.message);
        }
        return sendError(reply, 500, "SYNC_FAILED", "Repository synchronization failed");
      }
    }
  );

  server.post("/api/builds", { preHandler: requireContributor }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const parsed = z.object({ snapshotId: z.uuid() }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid build request");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await requireRepositoryRole("member", request, reply);
    if (!repository) return;
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
    const repository = await currentRepositoryForRead(request, reply);
    if (reply.sent) return;
    if (!repository) return { builds: [], ...paginationMetadata(0, parsed.data.offset ?? 0, 0) };
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
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    if (repository.id !== build.repositoryId) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    return { build };
  });

  server.post("/api/builds/:id/cancel", { preHandler: requireContributor }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const existing = parsed.success ? await options.store.getBuild(admin.workspaceId, parsed.data.id) : null;
    if (!existing) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    const repository = await requireRepositoryRole("member", request, reply);
    if (!repository) return;
    if (repository.id !== existing.repositoryId) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    const build = await options.buildService.cancelBuild(admin.workspaceId, existing.id);
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
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    if (repository.id !== build.repositoryId) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
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

  server.get("/api/builds/:id/stages", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const build = params.success ? await options.store.getBuild(admin.workspaceId, params.data.id) : null;
    if (!build) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    const repository = await options.store.getRepository(admin.workspaceId, build.repositoryId);
    if (!repository) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    await requireProjectRole("reader", repository.projectId, request, reply);
    if (reply.sent) return;
    const stages = await options.store.listPipelineStageRuns(
      admin.workspaceId,
      repository.projectId,
      build.id
    );
    return {
      buildId: build.id,
      legacyStatus: stages.length > 0
        ? legacyBuildStatus(stages, { published: build.status === "published" })
        : build.status,
      stages
    };
  });

  server.get("/api/builds/:id/stages/events", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const query = z.object({ once: z.string().optional() }).safeParse(request.query);
    if (!params.success || !query.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid stage event request");
    }
    const rawCursor = request.headers["last-event-id"];
    let afterSequence: number;
    try {
      afterSequence = parseLastStageEventId(typeof rawCursor === "string" ? rawCursor : undefined);
    } catch (error) {
      if (error instanceof InvalidStageEventCursorError) {
        return sendError(reply, 400, "INVALID_EVENT_CURSOR", error.message);
      }
      throw error;
    }
    const build = await options.store.getBuild(admin.workspaceId, params.data.id);
    if (!build) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    const repository = await options.store.getRepository(admin.workspaceId, build.repositoryId);
    if (!repository) return sendError(reply, 404, "BUILD_NOT_FOUND", "Build was not found");
    await requireProjectRole("reader", repository.projectId, request, reply);
    if (reply.sent) return;

    const replay = await options.store.listPipelineStageEvents(
      admin.workspaceId,
      repository.projectId,
      build.id,
      afterSequence
    );
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    if (query.data.once === "true") return reply.send(replay.map(stageSseEvent).join(""));

    const connectionCount = stageSseConnections.get(admin.id) ?? 0;
    if (connectionCount >= MAX_STAGE_SSE_CONNECTIONS_PER_USER) {
      return sendError(reply, 429, "SSE_CONNECTION_LIMIT", "Too many stage event connections");
    }
    stageSseConnections.set(admin.id, connectionCount + 1);
    let closed = false;
    let lastSequence = replay.at(-1)?.sequence ?? afterSequence;
    const release = () => {
      if (closed) return;
      closed = true;
      const remaining = (stageSseConnections.get(admin.id) ?? 1) - 1;
      if (remaining > 0) stageSseConnections.set(admin.id, remaining);
      else stageSseConnections.delete(admin.id);
      clearInterval(poll);
    };
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    for (const event of replay) reply.raw.write(stageSseEvent(event));
    const poll = setInterval(() => {
      void options.store.listPipelineStageEvents(
        admin.workspaceId,
        repository.projectId,
        build.id,
        lastSequence
      ).then((events) => {
        for (const event of events) {
          if (closed || event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          reply.raw.write(stageSseEvent(event));
        }
      }).catch(() => {
        release();
        reply.raw.end();
      });
    }, 1_000);
    request.raw.on("close", release);
  });

  server.get("/api/knowledge/search", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      q: z.string().trim().min(1).max(500),
      releaseId: z.string().max(100).optional()
    })
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid search query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
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
    const release = await options.store.getRelease(admin.workspaceId, parsed.data.releaseId);
    if (!release) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    if (repository.id !== release.repositoryId) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    return options.store.knowledgeMetadata(admin.workspaceId, parsed.data.releaseId);
  });

  server.get("/api/knowledge/pages", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({
      releaseId: z.string().max(100).optional(),
      ...paginationQuerySchema
    }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid page query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    const release = parsed.data.releaseId
      ? await options.store.getRelease(admin.workspaceId, parsed.data.releaseId)
      : await options.store.currentRelease(admin.workspaceId, repository.id);
    if (!release || release.repositoryId !== repository.id) {
      return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    }
    const [pages, total] = await Promise.all([
      options.store.listKnowledgePages(admin.workspaceId, release.id, parsed.data),
      options.store.countKnowledgePages(admin.workspaceId, release.id)
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
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    if (repository.id !== page.repositoryId) return sendError(reply, 404, "PAGE_NOT_FOUND", "Knowledge page was not found");
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
    const selected = parsed.data.releaseId
      ? await requireReleaseProjectRole("reader", parsed.data.releaseId, request, reply, "RELEASE_NOT_FOUND")
      : null;
    if (reply.sent) return;
    const repository = selected?.repository ?? await currentRepositoryForRead(request, reply);
    if (reply.sent) return;
    if (!repository) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const release = selected?.release ?? await options.store.currentRelease(admin.workspaceId, repository.id);
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

  server.post("/api/releases", { preHandler: requireContributor }, async (request, reply) => {
    const parsed = z.object({ buildId: z.string().min(1), version: z.string().trim().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid release draft");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await requireRepositoryRole("member", request, reply);
    if (!repository) return;
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
    const existing = await options.store.getRelease(admin.workspaceId, parsed.data.id);
    if (!existing) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const repository = await requireRepositoryRole("admin", request, reply);
    if (!repository) return;
    if (repository.id !== existing.repositoryId) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    try {
      return { release: await options.store.publishRelease(admin.workspaceId, parsed.data.id) };
    } catch (error) {
      return sendError(reply, 409, "PUBLISH_FAILED", error instanceof Error ? error.message : "Publish failed");
    }
  });

  server.get("/api/releases/current", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
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
    const repository = await requireRepositoryRole("reader", request, reply);
    if (!repository) return;
    if (repository.id !== release.repositoryId) return sendError(reply, 404, "RELEASE_NOT_FOUND", "Release was not found");
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, release.snapshotId);
    return { release: { ...release, commitSha: snapshot?.commitSha ?? null } };
  });

  server.get("/api/releases", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object(paginationQuerySchema).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid pagination");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await currentRepositoryForRead(request, reply);
    if (reply.sent) return;
    if (!repository) return { releases: [], ...paginationMetadata(0, parsed.data.offset ?? 0, 0) };
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
    const feedback = await options.store.listFeedback(admin.workspaceId, parsed.data.status, parsed.data);
    const scoped = (await Promise.all(feedback.map(async (item) => {
      if (!item.releaseId) return null;
      const release = await options.store.getRelease(admin.workspaceId, item.releaseId);
      const repository = release
        ? await options.store.getRepository(admin.workspaceId, release.repositoryId)
        : null;
      if (!release || !repository) return null;
      const access = await options.store.projectAccess(admin.workspaceId, repository.projectId, admin.id);
      if (!access?.role) return null;
      return {
        ...item,
        projectId: access.project.id,
        projectName: access.project.name,
        projectSlug: access.project.slug,
        releaseVersion: release.version
      };
    }))).filter((item): item is NonNullable<typeof item> => item !== null);
    return {
      feedback: scoped,
      ...paginationMetadata(scoped.length, parsed.data.offset ?? 0, scoped.length)
    };
  });

  server.patch("/api/feedback/:id", { preHandler: requireContributor }, async (request, reply) => {
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = z.object({ status: z.enum(AGENT_FEEDBACK_STATUSES) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback transition");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const existing = await options.store.getFeedback(admin.workspaceId, params.data.id);
    if (!existing) return sendError(reply, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found");
    const selected = await requireReleaseProjectRole(
      "member", existing.releaseId, request, reply, "FEEDBACK_NOT_FOUND"
    );
    if (!selected) return;
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

  server.post("/api/feedback/:id/rebuild", { preHandler: requireContributor }, async (request, reply) => {
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
    const selected = await requireReleaseProjectRole(
      "member", feedback.releaseId, request, reply, "FEEDBACK_NOT_FOUND"
    );
    if (!selected) return;
    const snapshot = await options.store.findSnapshotById(admin.workspaceId, selected.release.snapshotId);
    if (!snapshot) {
      return sendError(reply, 409, "UNPUBLISHED", "No published release can be rebuilt");
    }
    try {
      const result = await options.store.requestFeedbackRebuildWithAudit({
        workspaceId: admin.workspaceId,
        feedbackId: feedback.id,
        releaseId: selected.release.id,
        actorId: admin.id,
        build: {
          workspaceId: admin.workspaceId,
          repositoryId: selected.repository.id,
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
    const authentication = match ? await authenticateMcpTokenDetailed(options.store, match[1]) : { token: null, expired: false };
    const token = authentication.token;
    if (!token) return sendError(reply, 401, authentication.expired ? "MCP_TOKEN_EXPIRED" : "UNAUTHORIZED", authentication.expired ? "MCP token has expired" : "Invalid or revoked MCP token");
    const mcp = createRegisteredMcpServer({
      store: options.store,
      workspaceId: token.workspaceId,
      projectId: token.projectId,
      scopes: token.scopes,
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
