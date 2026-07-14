import { chmod, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app.js";
import { MemoryAppStore } from "./persistence/memory-store.js";
import type { RepositoryRecord } from "./persistence/store.js";

const apps: ReturnType<typeof buildServer>[] = [];
const temporaryDirectories: string[] = [];

async function archive(): Promise<Buffer> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output);
  await writer.add("src/index.ts", new TextReader("export const answer = 42;\n"));
  return Buffer.from(await writer.close());
}

function multipart(file: Buffer, filename = "source.zip") {
  const boundary = "----devkh-upload-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

class UploadRepositoryStore extends MemoryAppStore {
  uploadRepository: RepositoryRecord | null = null;

  override async currentRepository(workspaceId: string): Promise<RepositoryRecord | null> {
    return this.uploadRepository?.workspaceId === workspaceId ? this.uploadRepository : null;
  }
}

function activateUploadRepository(
  store: UploadRepositoryStore,
  workspaceId: string
): void {
  const projects = (store as unknown as { projects: Array<{ id: string; workspaceId: string }> }).projects;
  store.uploadRepository = {
    id: "upload-repository-1",
    workspaceId,
    projectId: projects.find((project) => project.workspaceId === workspaceId)!.id,
    kind: "upload",
    name: "Uploaded source",
    localPath: null,
    cloneUrl: null,
    defaultBranch: "upload",
    archivedAt: null,
    hasCredential: false
  } as unknown as RepositoryRecord;
}

async function authenticatedApp(store: MemoryAppStore = new MemoryAppStore()) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-upload-route-"));
  temporaryDirectories.push(dataDir);
  const app = buildServer({
    store,
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sessionSecret: "upload-route-session-secret",
    dataDir,
    nodeEnv: "test"
  });
  apps.push(app);
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  return {
    app,
    dataDir,
    workspaceId: setup.json().workspace.id as string,
    cookie: String(login.headers["set-cookie"]).split(";", 1)[0]
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(apps.splice(0).map((app) => app.close()));
  async function makeWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(directory, entry.name))
    ));
  }
  await Promise.all(temporaryDirectories.map(makeWritable));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("POST /api/repositories/current/uploads", () => {
  test("requires authentication before accepting a multipart body", async () => {
    const { app } = await authenticatedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/uploads",
      ...multipart(await archive())
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  test("returns a clear prerequisite when no repository is active", async () => {
    const { app, cookie } = await authenticatedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/uploads",
      headers: { cookie, ...multipart(Buffer.alloc(0)).headers },
      payload: multipart(Buffer.alloc(0)).payload
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "UPLOAD_REPOSITORY_REQUIRED" } });
  });

  test("does not add snapshots to local or git repositories", async () => {
    const { app, cookie } = await authenticatedApp();
    await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie },
      payload: { kind: "local", name: "Local", path: "/tmp/local" }
    });
    const body = multipart(await archive());
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/uploads",
      headers: { cookie, ...body.headers },
      payload: body.payload
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "UPLOAD_REPOSITORY_REQUIRED" } });
  });

  test("imports one ZIP for an upload repository and removes upload staging", async () => {
    const store = new UploadRepositoryStore();
    const context = await authenticatedApp(store);
    activateUploadRepository(store, context.workspaceId);
    const body = multipart(await archive());
    const response = await context.app.inject({
      method: "POST",
      url: "/api/repositories/current/uploads",
      headers: { cookie: context.cookie, ...body.headers },
      payload: body.payload
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      snapshotId: expect.any(String),
      sourceVersion: expect.stringMatching(/^[a-f0-9]{40}$/),
      fileCount: 1,
      unchanged: false,
      ignored: { total: 0, reasons: {} }
    });
    expect(store.sourceSnapshots).toHaveLength(1);
    expect(await readdir(path.join(context.dataDir, "uploads"))).toEqual([]);
  });

  test("promotes an uploaded replacement only after its ZIP import succeeds", async () => {
    const context = await authenticatedApp();
    await context.app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie: context.cookie },
      payload: { kind: "local", name: "Current project", path: "/tmp/current-project" }
    });
    const prepared = await context.app.inject({
      method: "POST",
      url: "/api/repositories/current/replace",
      headers: { cookie: context.cookie },
      payload: { kind: "upload", name: "Uploaded replacement" }
    });
    const candidateId = prepared.json().repository.id as string;
    const body = multipart(await archive());

    const imported = await context.app.inject({
      method: "POST",
      url: `/api/repositories/${candidateId}/uploads`,
      headers: { cookie: context.cookie, ...body.headers },
      payload: body.payload
    });

    expect(imported.statusCode).toBe(201);
    const current = await context.app.inject({
      method: "GET",
      url: "/api/repositories/current",
      headers: { cookie: context.cookie }
    });
    expect(current.json()).toMatchObject({ repository: { id: candidateId, kind: "upload" } });
  });

  test("discards a failed uploaded replacement while preserving the current repository", async () => {
    const context = await authenticatedApp();
    await context.app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { cookie: context.cookie },
      payload: { kind: "local", name: "Current project", path: "/tmp/current-project" }
    });
    const prepared = await context.app.inject({
      method: "POST",
      url: "/api/repositories/current/replace",
      headers: { cookie: context.cookie },
      payload: { kind: "upload", name: "Broken replacement" }
    });
    const body = multipart(Buffer.from("not a zip"));

    const imported = await context.app.inject({
      method: "POST",
      url: `/api/repositories/${prepared.json().repository.id}/uploads`,
      headers: { cookie: context.cookie, ...body.headers },
      payload: body.payload
    });

    expect(imported.statusCode).toBe(400);
    const current = await context.app.inject({ method: "GET", url: "/api/repositories/current", headers: { cookie: context.cookie } });
    expect(current.json()).toMatchObject({ repository: { name: "Current project", kind: "local" } });
    const archived = await context.app.inject({ method: "GET", url: "/api/repositories/archived", headers: { cookie: context.cookie } });
    expect(archived.json()).toEqual({ repositories: [] });
  });

  test("requires exactly one ZIP multipart file", async () => {
    const store = new UploadRepositoryStore();
    const { app, cookie, workspaceId, dataDir } = await authenticatedApp(store);
    activateUploadRepository(store, workspaceId);
    const boundary = "----devkh-two-files";
    const payload = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="one.zip"',
      "Content-Type: application/zip",
      "",
      "one",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="two.zip"',
      "Content-Type: application/zip",
      "",
      "two",
      `--${boundary}--`,
      ""
    ].join("\r\n"));
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/uploads",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_UPLOAD" } });
    expect(await readdir(path.join(dataDir, "uploads"))).toEqual([]);
  });
});

describe("resumable upload session routes", () => {
  test("creates an authenticated resumable session with bounded dimensions", async () => {
    const { app, cookie } = await authenticatedApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/uploads/resumable",
      headers: { cookie },
      payload: { totalBytes: 9, chunkSize: 4 }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: expect.any(String), totalBytes: 9, chunkSize: 4, receivedBytes: 0, complete: false
    });
  });

  test("accepts an indexed binary chunk and reports resumable progress", async () => {
    const { app, cookie } = await authenticatedApp();
    const session = await app.inject({
      method: "POST", url: "/api/uploads/resumable", headers: { cookie }, payload: { totalBytes: 8, chunkSize: 4 }
    });

    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/uploads/resumable/${session.json<{ id: string }>().id}/chunks/0`,
      headers: { cookie, "content-type": "application/octet-stream", "x-upload-chunk-size": "4" },
      payload: Buffer.from("abcd")
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ receivedBytes: 4, receivedChunks: 1, complete: false });
  });

  test("does not disclose one member's resumable session to another member", async () => {
    const { app, cookie } = await authenticatedApp();
    await app.inject({
      method: "POST", url: "/api/members", headers: { cookie },
      payload: { email: "member@example.com", password: "a secure member password", role: "member" }
    });
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: "a secure member password" }
    });
    const memberCookie = String(memberLogin.headers["set-cookie"]).split(";", 1)[0];
    const session = await app.inject({
      method: "POST", url: "/api/uploads/resumable", headers: { cookie }, payload: { totalBytes: 8, chunkSize: 4 }
    });

    const status = await app.inject({
      method: "GET", url: `/api/uploads/resumable/${session.json<{ id: string }>().id}`,
      headers: { cookie: memberCookie }
    });

    expect(status.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
    expect(status.statusCode).toBe(404);
  });

  test("finalizes a resumable ZIP into an immutable project upload snapshot", async () => {
    const { app, cookie, dataDir } = await authenticatedApp();
    const project = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "上传项目", slug: "upload-project" }
    });
    const projectId = project.json<{ project: { id: string } }>().project.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/repositories`,
      headers: { cookie },
      payload: { kind: "upload", name: "项目包" }
    });
    const zip = await archive();
    const session = await app.inject({
      method: "POST", url: "/api/uploads/resumable", headers: { cookie },
      payload: { totalBytes: zip.length, chunkSize: zip.length }
    });
    const sessionId = session.json<{ id: string }>().id;
    await app.inject({
      method: "PUT",
      url: `/api/uploads/resumable/${sessionId}/chunks/0`,
      headers: { cookie, "content-type": "application/octet-stream", "x-upload-chunk-size": String(zip.length) },
      payload: zip
    });

    const imported = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/uploads/resumable/${sessionId}/import`,
      headers: { cookie }
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ fileCount: 1, unchanged: false, sourceVersion: expect.any(String) });
    expect(await readdir(path.join(dataDir, "upload-staging", "sessions"))).toEqual([]);
    expect(await readdir(path.join(dataDir, "upload-staging", "completed"))).toEqual([]);
  });

  test("activates an uploaded replacement only after its resumable import succeeds", async () => {
    const { app, cookie, dataDir } = await authenticatedApp();
    await app.inject({
      method: "POST", url: "/api/repositories", headers: { cookie },
      payload: { kind: "local", name: "Current project", path: "/tmp/current-project" }
    });
    const prepared = await app.inject({
      method: "POST", url: "/api/repositories/current/replace", headers: { cookie },
      payload: { kind: "upload", name: "Uploaded replacement" }
    });
    const repositoryId = prepared.json<{ repository: { id: string } }>().repository.id;
    const zip = await archive();
    const session = await app.inject({
      method: "POST", url: "/api/uploads/resumable", headers: { cookie },
      payload: { totalBytes: zip.length, chunkSize: zip.length }
    });
    const sessionId = session.json<{ id: string }>().id;
    await app.inject({
      method: "PUT", url: `/api/uploads/resumable/${sessionId}/chunks/0`,
      headers: { cookie, "content-type": "application/octet-stream", "x-upload-chunk-size": String(zip.length) },
      payload: zip
    });

    const imported = await app.inject({
      method: "POST", url: `/api/repositories/${repositoryId}/uploads/resumable/${sessionId}/import`,
      headers: { cookie }
    });

    expect(imported.statusCode).toBe(201);
    const current = await app.inject({ method: "GET", url: "/api/repositories/current", headers: { cookie } });
    expect(current.json()).toMatchObject({ repository: { id: repositoryId, kind: "upload" } });
    expect(await readdir(path.join(dataDir, "upload-staging", "sessions"))).toEqual([]);
    expect(await readdir(path.join(dataDir, "upload-staging", "completed"))).toEqual([]);
  });
});
