import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";

const exec = promisify(execFile);
const directories: string[] = [];
const apps: ReturnType<typeof buildServer>[] = [];

async function git(cwd: string, ...args: string[]) {
  await exec("git", args, { cwd });
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devkh-route-git-"));
  directories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.email", "fixture@example.com");
  await git(directory, "config", "user.name", "Fixture Author");
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "src/index.ts"), "export const value = true;\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

async function configuredApp(repositoryPath: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-route-data-"));
  directories.push(dataDir);
  const store = new MemoryAppStore();
  const app = buildServer({
    store,
    dataDir,
    masterKey: Buffer.alloc(32, 1).toString("base64"),
    sessionSecret: "sync-route-session-secret",
    nodeEnv: "test"
  });
  apps.push(app);
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    payload: { email: "admin@example.com", password: "a secure admin password" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie },
    payload: { kind: "local", path: repositoryPath, name: "Fixture" }
  });
  return { app, store, cookie };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("repository sync route", () => {
  test("returns an immutable snapshot summary and audits success", async () => {
    const { app, store, cookie } = await configuredApp(await fixture());
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/sync",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ unchanged: false, ref: "main", fileCount: 1 });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: "repository.sync_succeeded" });
    expect(store.importReports).toHaveLength(1);
    expect(store.importReports[0]).toMatchObject({
      projectId: (await store.listProjects((await store.defaultWorkspace())!.id))[0].id,
      sourceKind: "local",
      status: "succeeded",
      collectedFileCount: 1,
      collectedTextBytes: "export const value = true;\n".length,
      ignored: { total: 0, reasons: {} }
    });
  });

  test("returns DIRTY_WORKTREE paths and audits failure", async () => {
    const repositoryPath = await fixture();
    const { app, store, cookie } = await configuredApp(repositoryPath);
    await writeFile(path.join(repositoryPath, "src/index.ts"), "export const value = false;\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/current/sync",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "DIRTY_WORKTREE", changedPaths: ["src/index.ts"] }
    });
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: "repository.sync_failed",
      metadata: { code: "DIRTY_WORKTREE" }
    });
  });
});
