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
  store.uploadRepository = {
    id: "upload-repository-1",
    workspaceId,
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
      unchanged: false
    });
    expect(store.sourceSnapshots).toHaveLength(1);
    expect(await readdir(path.join(context.dataDir, "uploads"))).toEqual([]);
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
