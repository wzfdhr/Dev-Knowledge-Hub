import { chmod, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app.js";
import { MemoryAppStore } from "./persistence/memory-store.js";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";

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

async function authenticatedApp() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-folder-route-"));
  temporaryDirectories.push(dataDir);
  const app = buildServer({
    store: new MemoryAppStore(), masterKey: Buffer.alloc(32, 7).toString("base64"),
    sessionSecret: "folder-route-session-secret", dataDir, nodeEnv: "test"
  });
  apps.push(app);
  await app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "a secure admin password" } });
  const login = await app.inject({ method: "POST", url: "/api/session", payload: { email: "admin@example.com", password: "a secure admin password" } });
  const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: authenticatedCookie(login) } });
  return { app, dataDir, cookie: authenticatedCookie(login), projectId: projects.json<{ projects: Array<{ id: string }> }>().projects[0].id };
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
  });

  test("does not register retired ZIP or resumable upload routes", async () => {
    const context = await authenticatedApp();
    const retired = await context.app.inject({ method: "POST", url: "/api/repositories/current/uploads", headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) }, payload: {} });
    expect(retired.statusCode).toBe(404);
    expect((await context.app.inject({ method: "POST", url: "/api/uploads/resumable", headers: { cookie: context.cookie, ...csrfHeaders(context.cookie) }, payload: {} })).statusCode).toBe(404);
  });
});
