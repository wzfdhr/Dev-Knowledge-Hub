import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app.js";
import { MemoryAppStore } from "./persistence/memory-store.js";
import type { CompleteFolderImportInput } from "./persistence/store.js";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
import { canonicalUploadManifestDigest } from "./uploads/upload-session";

const apps: ReturnType<typeof buildServer>[] = [];
const temporaryDirectories: string[] = [];

function folderMultipart(entries: Array<{ path: string; content: string }>) {
  const boundary = "----devkh-folder-upload-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      ...entries.flatMap((entry) => [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${entry.path}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from(entry.content),
        Buffer.from("\r\n")
      ]),
      Buffer.from(`--${boundary}--\r\n`)
    ])
  };
}

class RejectingFolderCompletionStore extends MemoryAppStore {
  override async completeFolderImport(input: CompleteFolderImportInput) {
    void input;
    return null;
  }
}

async function authenticatedApp(store: MemoryAppStore = new MemoryAppStore()) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-folder-route-"));
  temporaryDirectories.push(dataDir);
  const app = buildServer({
    store, masterKey: Buffer.alloc(32, 7).toString("base64"),
    sessionSecret: "folder-route-session-secret", dataDir, nodeEnv: "test"
  });
  apps.push(app);
  await app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "a secure admin password" } });
  const login = await app.inject({ method: "POST", url: "/api/session", payload: { email: "admin@example.com", password: "a secure admin password" } });
  const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: authenticatedCookie(login) } });
  return { app, store, dataDir, cookie: authenticatedCookie(login), projectId: projects.json<{ projects: Array<{ id: string }> }>().projects[0].id };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  async function writable(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => writable(path.join(directory, entry.name))));
  }
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.map(writable));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("folder import routes", () => {
  test("uploads a paged manifest, required bytes, and unverified asset metadata through one durable session", async () => {
    const context = await authenticatedApp();
    const createdRepository = await context.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/repositories`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) },
      payload: { kind: "upload", name: "Folder project" }
    });
    const repositoryId = createdRepository.json<{ repository: { id: string } }>().repository.id;
    const sourceText = "export const answer = 42;\n";
    const sourceHash = createHash("sha256").update(sourceText).digest("hex");
    const entries = [
      { ordinal: 0, path: "src/index.ts", kind: "source" as const, byteSize: Buffer.byteLength(sourceText), contentHash: sourceHash, mediaType: "text/typescript" },
      { ordinal: 1, path: "assets/logo.png", kind: "asset" as const, byteSize: 128, contentHash: null, mediaType: "image/png" }
    ];
    const headers = { cookie: context.cookie, ...csrfHeaders(context.cookie) };

    const created = await context.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/upload-sessions`,
      headers: { ...headers, "idempotency-key": "create-session" },
      payload: { repositoryId, entryCount: entries.length }
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const manifest = await context.app.inject({
      method: "PUT",
      url: `/api/projects/${context.projectId}/upload-sessions/${sessionId}/manifest-pages/0`,
      headers: { ...headers, "idempotency-key": "manifest-0" },
      payload: { entries }
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ entries: [
      { ordinal: 0, disposition: "upload_required", trust: "pending" },
      { ordinal: 1, disposition: "metadata_only", trust: "client_unverified" }
    ] });

    const uploaded = await context.app.inject({
      method: "PUT",
      url: `/api/projects/${context.projectId}/upload-sessions/${sessionId}/files/0`,
      headers: { ...headers, "idempotency-key": "file-0", "content-type": "application/octet-stream" },
      payload: Buffer.from(sourceText)
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ ordinal: 0, trust: "server_verified" });

    const commitRequest = {
      method: "POST" as const,
      url: `/api/projects/${context.projectId}/upload-sessions/${sessionId}/commit`,
      headers: { ...headers, "idempotency-key": "commit" },
      payload: { manifestDigest: canonicalUploadManifestDigest(entries) }
    };
    const committed = await context.app.inject(commitRequest);
    const replay = await context.app.inject(commitRequest);
    expect(committed.statusCode).toBe(201);
    expect(replay.json()).toEqual(committed.json());
    expect(committed.json()).toMatchObject({
      fileCount: 1,
      unchanged: false,
      assetCount: 1
    });
  });

  test("requires a bounded Idempotency-Key for every upload session write", async () => {
    const context = await authenticatedApp();
    const response = await context.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/upload-sessions`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) },
      payload: { repositoryId: "11111111-1111-4111-8111-111111111111", entryCount: 1 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
  });

  test("accepts a valid 500-entry manifest page larger than one MiB", async () => {
    const context = await authenticatedApp();
    const createdRepository = await context.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/repositories`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) },
      payload: { kind: "upload", name: "Large manifest" }
    });
    const repositoryId = createdRepository.json<{ repository: { id: string } }>().repository.id;
    const headers = { cookie: context.cookie, ...csrfHeaders(context.cookie) };
    const created = await context.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/upload-sessions`,
      headers: { ...headers, "idempotency-key": "large-manifest-create" },
      payload: { repositoryId, entryCount: 500 }
    });
    const sessionId = created.json<{ id: string }>().id;
    const entries = Array.from({ length: 500 }, (_, ordinal) => ({
      ordinal,
      path: `src/${String(ordinal).padStart(3, "0")}-${"a".repeat(2_200)}.ts`,
      kind: "source" as const,
      byteSize: 0,
      contentHash: createHash("sha256").update("").digest("hex"),
      mediaType: "text/typescript"
    }));
    expect(Buffer.byteLength(JSON.stringify({ entries }))).toBeGreaterThan(1024 * 1024);

    const response = await context.app.inject({
      method: "PUT",
      url: `/api/projects/${context.projectId}/upload-sessions/${sessionId}/manifest-pages/0`,
      headers: { ...headers, "idempotency-key": "large-manifest-page" },
      payload: { entries }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ entries: unknown[] }>().entries).toHaveLength(500);
  });

  test("imports only accepted direct files and records the server-side exclusions", async () => {
    const context = await authenticatedApp();
    await context.app.inject({ method: "POST", url: `/api/projects/${context.projectId}/repositories`, headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) }, payload: { kind: "upload", name: "Folder project" } });
    const body = folderMultipart([
      { path: "node_modules/package/index.js", content: "ignored" },
      { path: "src/index.ts", content: "export const answer = 42;\n" }
    ]);
    const response = await context.app.inject({ method: "POST", url: `/api/projects/${context.projectId}/folder-import`, headers: { cookie: context.cookie, ...csrfHeaders(context.cookie), ...body.headers }, payload: body.payload });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ fileCount: 1, ignored: { total: 1, reasons: { excluded_directory: 1 } } });
    const workspace = await context.store.defaultWorkspace();
    const repository = await context.store.currentRepository(workspace!.id, context.projectId);
    const snapshot = await context.store.latestSnapshot(workspace!.id, repository!.id);
    await expect(readdir(path.dirname(snapshot!.storagePath)))
      .resolves.not.toContain(".devkh-upload-session.json");
  });

  test("removes a pending compatibility snapshot when final completion is rejected", async () => {
    const context = await authenticatedApp(new RejectingFolderCompletionStore());
    await context.app.inject({
      method: "POST", url: `/api/projects/${context.projectId}/repositories`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) },
      payload: { kind: "upload", name: "Folder project" }
    });
    const body = folderMultipart([{ path: "src/index.ts", content: "export {};\n" }]);

    const response = await context.app.inject({
      method: "POST", url: `/api/projects/${context.projectId}/folder-import`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie), ...body.headers },
      payload: body.payload
    });

    expect(response.statusCode).toBe(500);
    expect(context.store.sourceSnapshots).toEqual([]);
    expect(context.store.sourceFiles).toEqual([]);
    await expect(readdir(path.join(context.dataDir, "snapshots"))).resolves.toEqual([]);
  });

  test("does not reactivate a populated archived repository through the compatibility route", async () => {
    const context = await authenticatedApp();
    const admin = (await context.store.defaultWorkspace())!;
    const projects = await context.store.listProjects(admin.id);
    const setupAdmin = (await context.store.listTeamMembers(admin.id))[0]!;
    await context.store.createRepository(
      admin.id, { kind: "upload", name: "Current" }, projects[0]!.id
    );
    const replacement = await context.store.prepareUploadReplacementWithAudit(
      admin.id, projects[0]!.id, "Historical", setupAdmin.id
    );
    await context.store.createSnapshotWithAudit({
      snapshot: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: admin.id,
        repositoryId: replacement!.id, commitSha: "a".repeat(40), ref: "upload/history",
        remoteUrl: null, commitTimestamp: new Date(), storagePath: "/tmp/history/files"
      },
      files: []
    }, setupAdmin.id);
    const body = folderMultipart([{ path: "src/index.ts", content: "export {};\n" }]);

    const response = await context.app.inject({
      method: "POST", url: `/api/repositories/${replacement!.id}/folder-import`,
      headers: { cookie: context.cookie, ...csrfHeaders(context.cookie), ...body.headers },
      payload: body.payload
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "UPLOAD_SESSION_INVALIDATED" } });
  });

  test("does not register retired ZIP or resumable upload routes", async () => {
    const context = await authenticatedApp();
    const retired = await context.app.inject({ method: "POST", url: "/api/repositories/current/uploads", headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) }, payload: {} });
    expect(retired.statusCode).toBe(404);
    expect((await context.app.inject({ method: "POST", url: "/api/uploads/resumable", headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) }, payload: {} })).statusCode).toBe(404);
  });
});
