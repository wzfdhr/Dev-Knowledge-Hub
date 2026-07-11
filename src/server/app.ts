import { randomBytes } from "node:crypto";

import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";

import { SERVICE_NAME } from "../shared/contracts.js";
import { MemoryAppStore } from "./persistence/memory-store.js";
import type { AdminRecord, AppStore } from "./persistence/store.js";
import type { RepositoryRecord } from "./persistence/store.js";
import { decryptSecret, encryptSecret } from "./security/crypto.js";
import { DirtyWorktreeError, syncRepository } from "./git/snapshot.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { createSessionToken, verifySessionToken } from "./security/session.js";

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
  masterKey: string;
  sessionSecret: string;
  dataDir: string;
  nodeEnv: "development" | "production" | "test";
}

interface AuthenticatedRequest extends FastifyRequest {
  sessionAdmin: AdminRecord;
}

function defaults(): ServerOptions {
  return {
    store: new MemoryAppStore(),
    masterKey: randomBytes(32).toString("base64"),
    sessionSecret: randomBytes(32).toString("base64url"),
    dataDir: "./data",
    nodeEnv: "test"
  };
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

export function buildServer(provided: Partial<ServerOptions> = {}): FastifyInstance {
  const options = { ...defaults(), ...provided };
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

  return server;
}
