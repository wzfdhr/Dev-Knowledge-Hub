import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "../../persistence/memory-store";
import { SourceAnalysisCache } from "./source-analysis-cache";

function baseKey(workspaceId: string) {
  return {
  workspaceId,
  contentHash: "a".repeat(64),
  analyzerId: "typescript-syntax",
  analyzerVersion: "1.0.0",
  parserConfigDigest: "b".repeat(64)
  };
}

async function fixture() {
  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  return { store, cache: new SourceAnalysisCache(store), key: baseKey(setup!.workspace.id) };
}

describe("SourceAnalysisCache", () => {
  test("computes once and reuses immutable pure syntax facts for the same workspace key", async () => {
    const { store, cache, key } = await fixture();
    let computations = 0;
    const compute = async () => {
      computations += 1;
      return {
        schemaVersion: 1,
        declarations: [{ kind: "function", name: "buildChart", start: 7, end: 42 }],
        imports: [{ specifier: "./chart-options", start: 0, end: 24 }]
      };
    };

    const first = await cache.getOrCompute(key, compute);
    const second = await cache.getOrCompute(key, compute);

    expect(first).toEqual(second);
    expect(computations).toBe(1);
    expect(store.sourceAnalysisArtifacts).toHaveLength(1);
  });

  test("isolates cache entries by workspace, analyzer version, and parser configuration", async () => {
    const { cache, key } = await fixture();
    const facts = { schemaVersion: 1, declarations: [] };
    await cache.put(key, facts);

    await expect(cache.get({ ...key, workspaceId: "00000000-0000-4000-8000-000000000002" })).resolves.toBeNull();
    await expect(cache.get({ ...key, analyzerVersion: "2.0.0" })).resolves.toBeNull();
    await expect(cache.get({ ...key, parserConfigDigest: "c".repeat(64) })).resolves.toBeNull();
  });

  test("rejects contextual metadata and oversized payloads before persistence", async () => {
    const { store, cache, key } = await fixture();

    for (const facts of [
      { schemaVersion: 1, projectId: "project-1" },
      { schemaVersion: 1, nested: { snapshotId: "snapshot-1" } },
      { schemaVersion: 1, declarations: [{ path: "src/app.ts" }] },
      { schemaVersion: 1, sourceRefs: [] }
    ]) {
      await expect(cache.put(key, facts)).rejects.toThrow("project-independent");
    }
    await expect(cache.put(key, { schemaVersion: 1, text: "x".repeat(8 * 1024 * 1024) }))
      .rejects.toThrow("8 MiB");
    expect(store.sourceAnalysisArtifacts).toHaveLength(0);
  });

  test("rejects a different payload for an existing immutable cache key", async () => {
    const { cache, key } = await fixture();
    await cache.put(key, { schemaVersion: 1, declarations: [] });

    await expect(cache.put(key, { schemaVersion: 1, declarations: [{ name: "different" }] }))
      .rejects.toThrow("cache collision");
  });
});
