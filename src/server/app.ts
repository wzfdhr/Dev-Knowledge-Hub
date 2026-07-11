import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import cookie from "@fastify/cookie";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";

import { AGENT_FEEDBACK_STATUSES, SERVICE_NAME } from "../shared/contracts.js";
import type { AdminRecord, AppStore } from "./persistence/store.js";
import type { RepositoryRecord } from "./persistence/store.js";
import { decryptSecret, encryptSecret } from "./security/crypto.js";
import { DirtyWorktreeError, syncRepository } from "./git/snapshot.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { createSessionToken, verifySessionToken } from "./security/session.js";
import type { BuildEvent, BuildService } from "./knowledge/build-service.js";
import {
  authenticateMcpToken,
  generateMcpToken,
  hashMcpToken,
  sanitizedMcpToken
} from "./mcp/auth.js";
import { createRegisteredMcpServer, MCP_TOOL_NAMES } from "./mcp/tools.js";

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

export interface ServerOptions {
  store: AppStore;
  buildService?: BuildService;
  masterKey: string;
  sessionSecret: string;
  dataDir: string;
  nodeEnv: "development" | "production" | "test";
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
  const server = Fastify({ logger: false });
  void server.register(cookie);

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

    await options.store.recordAudit({
      workspaceId: result.workspace.id,
      actorId: result.admin.id,
      action: "setup.completed",
      resourceType: "workspace",
      resourceId: result.workspace.id
    });
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
        await options.store.recordAudit({
          workspaceId: workspace.id,
          action: "session.login_failed",
          resourceType: "session",
          metadata: { email: parsed.success ? parsed.data.email : "invalid" }
        });
      }
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const token = await createSessionToken(
      { adminId: admin.id, workspaceId: admin.workspaceId },
      options.sessionSecret
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    await options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "session.login_succeeded",
      resourceType: "session"
    });
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

  server.post("/api/mcp/tokens", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const plaintext = generateMcpToken();
    const token = await options.store.createMcpToken({
      workspaceId: admin.workspaceId,
      name: parsed.data.name,
      tokenHash: hashMcpToken(plaintext),
      tokenPrefix: plaintext.slice(0, 12)
    });
    await options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "mcp_token.created",
      resourceType: "mcp_token",
      resourceId: token.id
    });
    return reply.code(201).send({ ...sanitizedMcpToken(token), token: plaintext });
  });

  server.get("/api/mcp/tokens", { preHandler: requireAdmin }, async (request) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return {
      tokens: (await options.store.listMcpTokens(admin.workspaceId)).map(sanitizedMcpToken)
    };
  });

  server.post("/api/mcp/tokens/:id/revoke", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid MCP token");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const token = await options.store.revokeMcpToken(admin.workspaceId, parsed.data.id);
    if (!token) return sendError(reply, 404, "TOKEN_NOT_FOUND", "MCP token was not found");
    await options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "mcp_token.revoked",
      resourceType: "mcp_token",
      resourceId: token.id
    });
    return { token: sanitizedMcpToken(token) };
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
    const repository = await options.store.createRepository(admin.workspaceId, input);
    if (!repository) {
      return sendError(reply, 409, "REPOSITORY_EXISTS", "A repository is already connected");
    }
    await options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "repository.connected",
      resourceType: "repository",
      resourceId: repository.id,
      metadata: { kind: repository.kind }
    });
    return reply.code(201).send(repositoryDto(repository));
  });

  server.get("/api/repositories/current", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return repositoryDto(repository);
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
          ...(encryptedCredential
            ? { token: decryptSecret(encryptedCredential, options.masterKey) }
            : {})
        });
        await options.store.recordAudit({
          workspaceId: admin.workspaceId,
          actorId: admin.id,
          action: "repository.sync_succeeded",
          resourceType: "repository",
          resourceId: repository.id,
          metadata: { commitSha: summary.commitSha, unchanged: summary.unchanged }
        });
        return summary;
      } catch (error) {
        const code = error instanceof DirtyWorktreeError ? error.code : "SYNC_FAILED";
        await options.store.recordAudit({
          workspaceId: admin.workspaceId,
          actorId: admin.id,
          action: "repository.sync_failed",
          resourceType: "repository",
          resourceId: repository.id,
          metadata: { code }
        });
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
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return { builds: await options.store.listBuilds(admin.workspaceId, repository.id) };
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
    const query = z.object({ once: z.string().optional() }).safeParse(request.query);
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
    const history = await options.store.listBuildEvents(admin.workspaceId, build.id);
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
    const parsed = z.object({ q: z.string().trim().min(1), releaseId: z.string().optional() })
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

  server.get("/api/knowledge/pages", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ releaseId: z.string().optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid page query");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return { pages: await options.store.listKnowledgePages(admin.workspaceId, parsed.data.releaseId) };
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
      path: z.string().min(1),
      startLine: z.coerce.number().int().positive(),
      endLine: z.coerce.number().int().positive(),
      releaseId: z.string().optional()
    }).refine((value) => value.endLine >= value.startLine && value.endLine - value.startLine <= 500)
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid source range");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    const release = parsed.data.releaseId
      ? (await options.store.listReleases(admin.workspaceId, repository.id))
        .find((candidate) => candidate.id === parsed.data.releaseId) ?? null
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
    const content = await fs.readFile(candidate, "utf8");
    if (createHash("sha256").update(content).digest("hex") !== sourceFile.contentHash) {
      return sendError(reply, 409, "SOURCE_CHANGED", "Snapshot source no longer matches its citation");
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
    return { release };
  });

  server.get("/api/releases", { preHandler: requireAdmin }, async (request, reply) => {
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const repository = await options.store.currentRepository(admin.workspaceId);
    if (!repository) return sendError(reply, 404, "REPOSITORY_NOT_FOUND", "No repository is connected");
    return { releases: await options.store.listReleases(admin.workspaceId, repository.id) };
  });

  server.get("/api/feedback", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ status: z.enum(AGENT_FEEDBACK_STATUSES).optional() })
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback filter");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    return { feedback: await options.store.listFeedback(admin.workspaceId, parsed.data.status) };
  });

  server.patch("/api/feedback/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = z.object({ status: z.enum(AGENT_FEEDBACK_STATUSES) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback transition");
    }
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    try {
      const feedback = await options.store.transitionFeedback(
        admin.workspaceId, params.data.id, body.data.status
      );
      if (!feedback) return sendError(reply, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found");
      await options.store.recordAudit({
        workspaceId: admin.workspaceId,
        actorId: admin.id,
        action: "feedback.transitioned",
        resourceType: "agent_feedback",
        resourceId: feedback.id,
        metadata: { status: feedback.status }
      });
      return { feedback };
    } catch {
      return sendError(reply, 409, "INVALID_FEEDBACK_TRANSITION", "Feedback transition is not allowed");
    }
  });

  server.post("/api/feedback/:id/rebuild", { preHandler: requireAdmin }, async (request, reply) => {
    if (!options.buildService) {
      return sendError(reply, 503, "BUILD_SERVICE_UNAVAILABLE", "Build service is unavailable");
    }
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid feedback rebuild");
    const admin = (request as AuthenticatedRequest).sessionAdmin;
    const feedback = (await options.store.listFeedback(admin.workspaceId))
      .find((candidate) => candidate.id === params.data.id);
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
    const result = await options.buildService.startBuild({
      workspaceId: admin.workspaceId,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath,
      commitSha: snapshot.commitSha
    });
    await options.store.markFeedbackRebuild(admin.workspaceId, feedback.id, result.build.id);
    await options.store.recordAudit({
      workspaceId: admin.workspaceId,
      actorId: admin.id,
      action: "feedback.rebuild_requested",
      resourceType: "agent_feedback",
      resourceId: feedback.id,
      metadata: { buildId: result.build.id, releaseId: release.id }
    });
    return reply.code(result.created ? 202 : 200).send(result);
  });

  server.all("/mcp", async (request, reply) => {
    const authorization = request.headers.authorization;
    const match = /^Bearer (\S+)$/i.exec(authorization ?? "");
    const token = match ? await authenticateMcpToken(options.store, match[1]) : null;
    if (!token) return sendError(reply, 401, "UNAUTHORIZED", "Invalid or revoked MCP token");
    const mcp = createRegisteredMcpServer({ store: options.store, workspaceId: token.workspaceId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await mcp.connect(transport);
    reply.hijack();
    reply.raw.once("finish", () => void mcp.close());
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  return server;
}
