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
  await store.transitionBuild(build.id, "queued", "ready");
  const release = await store.createReleaseDraft(workspaceId, repositoryId, build.id, "1.0.0");
  await store.publishRelease(workspaceId, release.id);
});

describe("weighted knowledge search", () => {
  test("ranks an exact symbol above a body-only text match", async () => {
    const results = await store.searchKnowledge(workspaceId, repositoryId, "add");

    expect(results[0]).toEqual(expect.objectContaining({ kind: "symbol", title: "add" }));
    expect(results[0].matchReason).toBe("精确符号匹配");
    expect(results[0].score).toBeGreaterThan(
      results.find((result) => result.kind === "page")?.score ?? 0
    );
    expect(results[0].releaseId).toBeTruthy();
    expect(results[0].citations[0]).toEqual(expect.objectContaining({ commitSha: build.commitSha }));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dependency-neighbor", title: "src/math.ts" })
    ]));
    const moduleNeighbor = results.find((result) =>
      result.kind === "dependency-neighbor" && result.title === "src/math.ts"
    );
    expect(store.knowledgePages.find((page) => page.id === moduleNeighbor?.pageId)?.title)
      .toBe("模块：src/math.ts");
  });

  test("ranks exact paths and dependency neighbors deterministically", async () => {
    const pathResults = await store.searchKnowledge(workspaceId, repositoryId, "src/math.ts");
    const neighborResults = await store.searchKnowledge(workspaceId, repositoryId, "src/util.js");

    expect(pathResults[0]).toEqual(expect.objectContaining({ kind: "module", title: "src/math.ts" }));
    expect(pathResults[0].matchReason).toBe("精确路径匹配");
    expect(neighborResults.some((result) => result.kind === "dependency-neighbor")).toBe(true);
    expect(neighborResults).toEqual([...neighborResults].sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title)
    ));
  });

  test("matches feedback wording against camel-cased symbols", async () => {
    const results = await store.searchKnowledge(workspaceId, repositoryId, "parse failure");

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "ParseFailureError" })
    ]));
  });

  test("binds neighbors to their own pages, dedupes before a stable cap, and retains text results", async () => {
    const citation = index.files.find((file) => file.path === "src/math.ts")!;
    for (let position = 0; position < 55; position += 1) {
      const source = `src/neighbors/${String(position).padStart(2, "0")}.ts`;
      index.edges.push({
        kind: "module-dependency",
        source,
        target: "src/util.js",
        citation
      });
      store.knowledgePages.push({
        id: `${build.id}:neighbor-${position}`,
        workspaceId,
        repositoryId,
        buildId: build.id,
        slug: `modules/src-neighbors-${String(position).padStart(2, "0")}-ts`,
        title: `模块：${source}`,
        body: `# 模块：${source}\n\n使用 src/util.js 处理边界值。`,
        chunks: [{
          id: `${build.id}:neighbor-chunk-${position}`,
          heading: `模块：${source}`,
          content: `Uses src/util.js for bounded values.`,
          citations: [citation]
        }]
      });
    }
    index.edges.push({
      kind: "module-dependency",
      source: "src/missing-source.ts",
      target: "src/util.js",
      citation
    });

    const first = await store.searchKnowledge(workspaceId, repositoryId, "src/util.js");
    const second = await store.searchKnowledge(workspaceId, repositoryId, "src/util.js");

    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(50);
    expect(first.some((result) => result.kind === "page")).toBe(true);
    expect(first.some((result) => result.title === "src/missing-source.ts")).toBe(false);
    expect(first.filter((result) => result.kind === "dependency-neighbor").every((result) =>
      store.knowledgePages.some((page) =>
        page.id === result.pageId && page.title === `模块：${result.title}`
      )
    )).toBe(true);
  });
});
