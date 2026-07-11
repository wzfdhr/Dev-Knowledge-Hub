import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test } from "vitest";

import { generateKnowledge } from "./generator";
import { analyzeSnapshot, type CodeIndex } from "./intelligence";
import { MemoryAppStore } from "../persistence/memory-store";
import type { BuildRecord } from "./build-service";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);

let store: MemoryAppStore;
let workspaceId: string;
let repositoryId: string;
let build: BuildRecord;
let index: CodeIndex;

beforeEach(async () => {
  store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  workspaceId = setup!.workspace.id;
  repositoryId = (await store.createRepository(workspaceId, {
    kind: "local", name: "Fixture", path: fixtureRoot
  }))!.id;
  build = (await store.createBuild({
    workspaceId,
    repositoryId,
    snapshotId: "snapshot-1",
    snapshotPath: fixtureRoot,
    commitSha: "d".repeat(40)
  })).build;
  index = await analyzeSnapshot(fixtureRoot, build.commitSha);
  const output = await generateKnowledge(index);
  await store.saveKnowledge({ build, index, output });
  await store.transitionBuild(build.id, "ready");
  const release = await store.createReleaseDraft(workspaceId, repositoryId, build.id, "1.0.0");
  await store.publishRelease(workspaceId, release.id);
});

describe("weighted knowledge search", () => {
  test("ranks an exact symbol above a body-only text match", async () => {
    const results = await store.searchKnowledge(workspaceId, repositoryId, "add");

    expect(results[0]).toEqual(expect.objectContaining({ kind: "symbol", title: "add" }));
    expect(results[0].score).toBeGreaterThan(
      results.find((result) => result.kind === "page")?.score ?? 0
    );
    expect(results[0].releaseId).toBeTruthy();
    expect(results[0].citations[0]).toEqual(expect.objectContaining({ commitSha: build.commitSha }));
  });

  test("ranks exact paths and dependency neighbors deterministically", async () => {
    const pathResults = await store.searchKnowledge(workspaceId, repositoryId, "src/math.ts");
    const neighborResults = await store.searchKnowledge(workspaceId, repositoryId, "src/util.js");

    expect(pathResults[0]).toEqual(expect.objectContaining({ kind: "module", title: "src/math.ts" }));
    expect(neighborResults.some((result) => result.kind === "dependency-neighbor")).toBe(true);
    expect(neighborResults).toEqual([...neighborResults].sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title)
    ));
  });
});
