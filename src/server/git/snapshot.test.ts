import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store";
import type { RepositoryRecord } from "../persistence/store";
import { DirtyWorktreeError, syncRepository } from "./snapshot";
import { SourceBlobStore } from "../uploads/source-blob-store";
import { removeReadOnlyTree } from "../uploads/folder-import";

const exec = promisify(execFile);
const tempDirectories: string[] = [];

async function git(cwd: string, ...args: string[]) {
  await exec("git", args, { cwd });
}

async function fixtureRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devkh-git-fixture-"));
  tempDirectories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.email", "fixture@example.com");
  await git(directory, "config", "user.name", "Fixture Author");
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "src/index.ts"), "export const answer = 42;\n");
  await writeFile(path.join(directory, "README.md"), "# Fixture\n");
  await writeFile(path.join(directory, "package.json"), '{"name":"fixture"}\n');
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial fixture");
  return directory;
}

function localRepository(localPath: string): RepositoryRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    kind: "local",
    name: "Fixture",
    localPath,
    cloneUrl: null,
    defaultBranch: "main",
    archivedAt: null,
    hasCredential: false
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => removeReadOnlyTree(directory)));
});

describe("immutable repository snapshots", () => {
  test("shadow mode writes Git sources once and materializes a hardlinked snapshot view", async () => {
    const repositoryPath = await fixtureRepository();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-git-blobs-"));
    tempDirectories.push(dataDir);
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("git-blob@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0]!;
    const repository = {
      ...localRepository(repositoryPath),
      workspaceId: setup!.workspace.id,
      projectId: project.id
    };
    const sourceDataDir = path.join(dataDir, "source-data");
    const sourceBlobStore = new SourceBlobStore({ dataDir: sourceDataDir, catalog: store });
    await sourceBlobStore.initialize();

    const summary = await syncRepository({
      repository,
      dataDir,
      store,
      sourceStorageMode: "shadow",
      sourceBlobStore
    });

    const sourceFile = store.sourceFiles.find((file) => file.path === "src/index.ts")!;
    const blob = store.sourceBlobs.find((candidate) => candidate.id === sourceFile.sourceBlobId)!;
    const snapshot = store.sourceSnapshots[0]!;
    expect(blob).toBeDefined();
    expect((await stat(path.join(snapshot.storagePath, sourceFile.path))).ino)
      .toBe((await stat(path.join(sourceDataDir, ...blob.storageKey.split("/")))).ino);
    expect(summary.fileCount).toBe(3);
  });

  test("scans tracked source files and persists immutable content metadata", async () => {
    const repositoryPath = await fixtureRepository();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-data-"));
    tempDirectories.push(dataDir);
    const store = new MemoryAppStore();

    const summary = await syncRepository({
      repository: localRepository(repositoryPath),
      dataDir,
      store
    });

    expect(summary).toMatchObject({ unchanged: false, ref: "main", fileCount: 3 });
    expect(summary.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(store.sourceSnapshots).toHaveLength(1);
    expect(store.sourceSnapshots[0]).toMatchObject({
      commitSha: summary.commitSha,
      ref: "main",
      remoteUrl: null,
      storagePath: path.join(dataDir, "snapshots", summary.snapshotId, "files")
    });
    const source = "export const answer = 42;\n";
    expect(store.sourceFiles).toContainEqual(expect.objectContaining({
      path: "src/index.ts",
      byteSize: Buffer.byteLength(source),
      contentHash: createHash("sha256").update(source).digest("hex"),
      language: "typescript"
    }));
    const storedPath = path.join(dataDir, "snapshots", summary.snapshotId, "files", "src/index.ts");
    await expect(readFile(storedPath, "utf8")).resolves.toBe(source);
  });

  test("rejects any dirty local worktree with structured changed paths", async () => {
    const repositoryPath = await fixtureRepository();
    await writeFile(path.join(repositoryPath, "src/index.ts"), "export const answer = 43;\n");
    await writeFile(path.join(repositoryPath, "untracked.md"), "not committed\n");

    const error = await syncRepository({
      repository: localRepository(repositoryPath),
      dataDir: await mkdtemp(path.join(os.tmpdir(), "devkh-data-")),
      store: new MemoryAppStore()
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DirtyWorktreeError);
    expect(error).toMatchObject({
      code: "DIRTY_WORKTREE",
      changedPaths: expect.arrayContaining(["src/index.ts", "untracked.md"])
    });
  });

  test("reports both paths for a staged rename", async () => {
    const repositoryPath = await fixtureRepository();
    await git(repositoryPath, "mv", "README.md", "GUIDE.md");

    const error = await syncRepository({
      repository: localRepository(repositoryPath),
      dataDir: await mkdtemp(path.join(os.tmpdir(), "devkh-data-")),
      store: new MemoryAppStore()
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DirtyWorktreeError);
    expect(error).toMatchObject({
      changedPaths: expect.arrayContaining(["README.md", "GUIDE.md"])
    });
  });

  test("skips ignored formats, generated files, binary content, and files over one MiB", { timeout: 15_000 }, async () => {
    const repositoryPath = await fixtureRepository();
    await mkdir(path.join(repositoryPath, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(repositoryPath, "dist"), { recursive: true });
    await writeFile(path.join(repositoryPath, "node_modules/pkg/index.js"), "export {};\n");
    await writeFile(path.join(repositoryPath, "dist/bundle.js"), "export {};\n");
    await writeFile(path.join(repositoryPath, "secret.env"), "TOKEN=secret\n");
    await writeFile(path.join(repositoryPath, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(repositoryPath, ".env.example"), "TOKEN=\n");
    await writeFile(path.join(repositoryPath, "generated.ts"), "// @generated\nexport {};\n");
    await writeFile(path.join(repositoryPath, "binary.js"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(repositoryPath, "invalid-utf8.ts"), Buffer.from([0xc3, 0x28, 0x0a]));
    await writeFile(path.join(repositoryPath, "large.ts"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    await git(repositoryPath, "add", "-f", ".");
    await git(repositoryPath, "commit", "-m", "add filtering cases");

    const store = new MemoryAppStore();
    const summary = await syncRepository({
      repository: localRepository(repositoryPath),
      dataDir: await mkdtemp(path.join(os.tmpdir(), "devkh-data-")),
      store
    });

    expect(store.sourceFiles.map(({ path: filePath }) => filePath)).toEqual([
      ".env.example",
      "README.md",
      "package.json",
      "src/index.ts"
    ]);
    expect(summary.fileCount).toBe(4);
  });

  test("returns unchanged for the same SHA and creates a snapshot for the next commit", { timeout: 15_000 }, async () => {
    const repositoryPath = await fixtureRepository();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-data-"));
    tempDirectories.push(dataDir);
    const store = new MemoryAppStore();
    const repository = localRepository(repositoryPath);

    const first = await syncRepository({ repository, dataDir, store });
    const unchanged = await syncRepository({ repository, dataDir, store });
    expect(unchanged).toMatchObject({
      unchanged: true,
      snapshotId: first.snapshotId,
      commitSha: first.commitSha
    });
    expect(store.sourceSnapshots).toHaveLength(1);

    await writeFile(path.join(repositoryPath, "src/index.ts"), "export const answer = 43;\n");
    await git(repositoryPath, "add", "src/index.ts");
    await git(repositoryPath, "commit", "-m", "change answer");
    const second = await syncRepository({ repository, dataDir, store });

    expect(second.unchanged).toBe(false);
    expect(second.commitSha).not.toBe(first.commitSha);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(store.sourceSnapshots).toHaveLength(2);
  });

  test("serializes concurrent syncs so one snapshot is created per repository SHA", async () => {
    const repositoryPath = await fixtureRepository();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-data-"));
    tempDirectories.push(dataDir);
    const store = new MemoryAppStore();
    const repository = localRepository(repositoryPath);

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      syncRepository({ repository, dataDir, store })
    ));

    expect(results.filter(({ unchanged }) => !unchanged)).toHaveLength(1);
    expect(results.filter(({ unchanged }) => unchanged)).toHaveLength(4);
    expect(new Set(results.map(({ snapshotId }) => snapshotId)).size).toBe(1);
    expect(store.sourceSnapshots).toHaveLength(1);
  });

  test("sanitizes credentialized local remote URLs before persistence", async () => {
    const repositoryPath = await fixtureRepository();
    await git(
      repositoryPath,
      "remote",
      "add",
      "origin",
      ["https://git-user", ["github", "pat", "NOT_PERSISTED"].join("_")]
        .join(":") + "@example.com/private.git"
    );
    const store = new MemoryAppStore();

    await syncRepository({
      repository: localRepository(repositoryPath),
      dataDir: await mkdtemp(path.join(os.tmpdir(), "devkh-data-")),
      store
    });

    expect(store.sourceSnapshots[0].remoteUrl).toBe("https://example.com/private.git");
    expect(JSON.stringify(store.sourceSnapshots)).not.toContain(
      ["github", "pat", "NOT_PERSISTED"].join("_")
    );
  });

  test("preserves the resolved remote tracking ref for detached HTTPS snapshots", async () => {
    const repositoryPath = await fixtureRepository();
    await git(repositoryPath, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(
      repositoryPath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main"
    );
    const repository: RepositoryRecord = {
      ...localRepository(repositoryPath),
      kind: "git",
      localPath: null,
      cloneUrl: "https://example.com/private.git"
    };
    const store = new MemoryAppStore();

    const summary = await syncRepository({
      repository,
      dataDir: await mkdtemp(path.join(os.tmpdir(), "devkh-data-")),
      store,
      prepareRemote: async () => repositoryPath
    });

    expect(summary.ref).toBe("origin/main");
    expect(store.sourceSnapshots[0]).toMatchObject({
      ref: "origin/main",
      remoteUrl: "https://example.com/private.git"
    });
  });
});
