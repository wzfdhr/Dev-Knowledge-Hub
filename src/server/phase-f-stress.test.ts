import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { BuildService, type BuildJobQueue } from "./knowledge/build-service.js";
import { MemoryAppStore } from "./persistence/memory-store.js";
import { importFolderFiles, type FolderUploadFile } from "./uploads/folder-import.js";

const directories: string[] = [];

class ManualQueue implements BuildJobQueue {
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function* sourceFiles(project: string): AsyncGenerator<FolderUploadFile> {
  yield {
    path: `src/${project}.ts`,
    content: Buffer.from(`export const ${project.replace(/-/g, "_")} = "${project}";\n`)
  };
  yield { path: "README.md", content: Buffer.from(`# ${project}\n`) };
}

afterEach(async () => {
  async function makeWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(directory, entry.name))
    ));
  }
  for (const directory of directories.splice(0)) {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Phase F concurrency baseline", () => {
  test("keeps three imports, two builds, and ten searches isolated within the resource budget", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-phase-f-stress-"));
    directories.push(dataDir);
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const firstProject = (await store.listProjects(workspaceId))[0]!;
    const secondProject = (await store.createProject(workspaceId, {
      name: "Second project", slug: "second-project"
    }, setup!.admin.id))!;
    const thirdProject = (await store.createProject(workspaceId, {
      name: "Third project", slug: "third-project"
    }, setup!.admin.id))!;
    const projects = [firstProject, secondProject, thirdProject];
    const repositories = await Promise.all(projects.map((project) => store.createRepository(
      workspaceId, { kind: "upload", name: project.slug }, project.id
    )));

    const imports = await Promise.all(repositories.map((repository, index) => importFolderFiles({
      files: sourceFiles(projects[index]!.slug),
      dataDir,
      workspaceId,
      repositoryId: repository!.id,
      actorId: setup!.admin.id,
      store
    })));
    expect(imports.map((item) => item.fileCount)).toEqual([2, 2, 2]);
    expect(new Set(imports.map((item) => item.snapshotId)).size).toBe(3);

    const buildService = new BuildService(store, new ManualQueue());
    const started = await Promise.all(imports.slice(0, 2).map((snapshot, index) => buildService.startBuild({
      workspaceId,
      repositoryId: repositories[index]!.id,
      snapshotId: snapshot.snapshotId,
      snapshotPath: snapshot.storagePath,
      commitSha: snapshot.sourceVersion
    })));
    await Promise.all(started.map(({ build }) => buildService.process(build.id)));
    const builds = await Promise.all(started.map(({ build }) => store.getBuild(workspaceId, build.id)));
    expect(builds).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ready", repositoryId: repositories[0]!.id }),
      expect.objectContaining({ status: "ready", repositoryId: repositories[1]!.id })
    ]));

    await Promise.all(builds.map(async (build, index) => {
      const release = await store.createReleaseDraft(
        workspaceId, repositories[index]!.id, build!.id, `1.0.${index}`
      );
      await store.publishRelease(workspaceId, release.id);
    }));

    const searchStartedAt = performance.now();
    const searches = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const repositoryIndex = index % 2;
      const startedAt = performance.now();
      const results = await store.searchKnowledge(
        workspaceId, repositories[repositoryIndex]!.id, projects[repositoryIndex]!.slug
      );
      return { repositoryIndex, results, durationMs: performance.now() - startedAt };
    }));
    const elapsedMs = performance.now() - searchStartedAt;
    const sortedDurations = searches.map((search) => search.durationMs).sort((left, right) => left - right);
    const p95Ms = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1]!;

    expect(searches).toHaveLength(10);
    expect(searches.every(({ results }) => results.length > 0)).toBe(true);
    expect(searches.filter(({ repositoryIndex }) => repositoryIndex === 0).every(({ results }) =>
      results.every((result) => result.citations.every((citation) => citation.path.includes("default-project")))
    )).toBe(true);
    expect(searches.filter(({ repositoryIndex }) => repositoryIndex === 1).every(({ results }) =>
      results.every((result) => result.citations.every((citation) => citation.path.includes("second-project")))
    )).toBe(true);
    expect(p95Ms).toBeLessThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThanOrEqual(1_000);
    expect(process.memoryUsage().rss).toBeLessThanOrEqual(1.5 * 1024 * 1024 * 1024);
  }, 30_000);
});
