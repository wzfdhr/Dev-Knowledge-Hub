import { chmod, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store.js";
import { FolderUploadError, importFolderFiles, type FolderUploadFile } from "./folder-import.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-folder-upload-"));
  temporaryDirectories.push(dataDir);
  return { dataDir, store: new MemoryAppStore() };
}

async function* files(values: Array<[string, string]>): AsyncGenerator<FolderUploadFile> {
  for (const [filePath, content] of values) yield { path: filePath, content: Buffer.from(content) };
}

afterEach(async () => {
  async function makeWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(directory, entry.name))
    ));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await makeWritable(directory);
    await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true });
  }
});

describe("folder snapshot import", () => {
  test("uploads only accepted files, filters dependencies before snapshotting, and creates a stable content version", async () => {
    const context = await fixture();
    const summary = await importFolderFiles({
      files: files([
        ["node_modules/huge/index.js", "ignored"],
        [".env", "TOKEN=secret"],
        ["src/index.ts", "export const answer = 42;\n"],
        ["README.md", "# Demo\n"]
      ]),
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    });

    expect(summary).toMatchObject({ fileCount: 2, sourceVersion: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(summary.ignored).toEqual({ total: 2, reasons: { excluded_directory: 1, sensitive_file: 1 } });
    expect(context.store.sourceFiles.map((file) => file.path).sort()).toEqual(["README.md", "src/index.ts"]);
    expect(await readFile(path.join(summary.storagePath, "src/index.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect((await stat(path.join(summary.storagePath, "src/index.ts"))).mode & 0o222).toBe(0);
  });

  test("rejects unsafe and duplicate relative paths", async () => {
    const context = await fixture();
    const options = { dataDir: context.dataDir, workspaceId: "workspace-1", repositoryId: "repository-1", actorId: "admin-1", store: context.store };
    await expect(importFolderFiles({ ...options, files: files([["../src/index.ts", "export {};" ]]) })).rejects.toMatchObject({ code: "UNSAFE_FOLDER_PATH" });
    await expect(importFolderFiles({ ...options, files: files([["src/index.ts", "export {};"], ["src/index.ts", "export {};" ]]) })).rejects.toMatchObject({ code: "DUPLICATE_FOLDER_PATH" });
  });

  test("exposes typed folder errors without retaining staging data", async () => {
    const context = await fixture();
    await expect(importFolderFiles({
      files: files([[".env", "TOKEN=secret"]]),
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    })).rejects.toMatchObject({ code: "EMPTY_FOLDER_UPLOAD" });
    expect(new FolderUploadError("TOO_MANY_FILES", "too many")).toMatchObject({ name: "FolderUploadError", code: "TOO_MANY_FILES" });
    await expect(readdir(path.join(context.dataDir, "uploads"))).resolves.toEqual([]);
  });
});
