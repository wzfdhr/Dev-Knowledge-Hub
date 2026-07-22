import { describe, expect, test, vi } from "vitest";

import {
  ExperienceProjectionCache,
  experienceProjectionCacheKey
} from "./experience-projection-cache";

const baseKey = {
  workspaceId: "workspace-1", userId: "user-1", sessionVersion: 1, aclRevision: 1,
  visibleReleaseSetDigest: "a".repeat(64), currentProjectId: "project-1",
  currentProjectProfileDigest: "b".repeat(64), queryIntentDigest: "c".repeat(64),
  experienceSchemaVersion: 1, rankingVersion: 1
};

describe("experience projection cache", () => {
  test("invalidates a cached projection when ACL revision or release visibility changes", async () => {
    const cache = new ExperienceProjectionCache<{ visibleReleaseIds: string[] }>({ capacity: 10, ttlMs: 60_000 });
    const loader = vi.fn(async () => ({ visibleReleaseIds: ["secret-release"] }));

    await cache.getOrLoad(experienceProjectionCacheKey(baseKey), loader);
    loader.mockResolvedValueOnce({ visibleReleaseIds: [] });
    const next = await cache.getOrLoad(experienceProjectionCacheKey({
      ...baseKey, aclRevision: 2, visibleReleaseSetDigest: "d".repeat(64)
    }), loader);

    expect(next.visibleReleaseIds).not.toContain("secret-release");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("binds cache entries to session, project profile, schema and ranking versions", () => {
    const serialized = experienceProjectionCacheKey(baseKey);

    for (const changed of [
      { sessionVersion: 2 }, { currentProjectProfileDigest: "d".repeat(64) },
      { experienceSchemaVersion: 2 }, { rankingVersion: 2 }
    ]) {
      expect(experienceProjectionCacheKey({ ...baseKey, ...changed })).not.toBe(serialized);
    }
  });

  test("evicts the least-recently-used entry at the configured capacity", async () => {
    const cache = new ExperienceProjectionCache<number>({ capacity: 2, ttlMs: 60_000 });
    const load = vi.fn(async () => 1);
    await cache.getOrLoad("one", load);
    await cache.getOrLoad("two", load);
    await cache.getOrLoad("three", load);
    await cache.getOrLoad("one", load);

    expect(load).toHaveBeenCalledTimes(4);
  });
});
