import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { generateKnowledge } from "./generator";
import { analyzeSnapshot } from "./intelligence";
import { MemoryAppStore } from "../persistence/memory-store";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);

describe("immutable releases", () => {
  test("drafts do not move current, publish is atomic, and old releases remain readable", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, {
      kind: "local", name: "Fixture", path: fixtureRoot
    });

    async function readyBuild(snapshotId: string, versionMarker: string) {
      const build = (await store.createBuild({
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId,
        snapshotPath: fixtureRoot,
        commitSha: versionMarker.repeat(40)
      })).build;
      const index = await analyzeSnapshot(fixtureRoot, build.commitSha);
      const output = await generateKnowledge(index);
      output.pages.find((page) => page.slug === "architecture-overview")!.body += `\n\n${versionMarker}`;
      await store.saveKnowledge({ build, index, output });
      await store.transitionBuild(build.id, "queued", "ready");
      return build;
    }

    const firstBuild = await readyBuild("snapshot-1", "e");
    const first = await store.createReleaseDraft(
      setup!.workspace.id, repository!.id, firstBuild.id, "1.0.0"
    );
    expect(await store.currentRelease(setup!.workspace.id, repository!.id)).toBeNull();
    await store.publishRelease(setup!.workspace.id, first.id);

    const secondBuild = await readyBuild("snapshot-2", "f");
    const second = await store.createReleaseDraft(
      setup!.workspace.id, repository!.id, secondBuild.id, "2.0.0"
    );
    expect((await store.currentRelease(setup!.workspace.id, repository!.id))?.id).toBe(first.id);
    const firstPagesBefore = await store.listKnowledgePages(setup!.workspace.id, first.id);

    await store.publishRelease(setup!.workspace.id, second.id);

    expect((await store.currentRelease(setup!.workspace.id, repository!.id))?.id).toBe(second.id);
    expect(await store.listKnowledgePages(setup!.workspace.id, first.id)).toEqual(firstPagesBefore);
    expect((await store.listReleases(setup!.workspace.id, repository!.id)).map((release) => release.id))
      .toEqual([second.id, first.id]);
  });

  test("rejects draft creation for failed builds and preserves current", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, {
      kind: "local", name: "Fixture", path: fixtureRoot
    });
    const failed = (await store.createBuild({
      workspaceId: setup!.workspace.id,
      repositoryId: repository!.id,
      snapshotId: "snapshot-failed",
      snapshotPath: fixtureRoot,
      commitSha: "0".repeat(40)
    })).build;
    await store.transitionBuild(failed.id, "queued", "failed", { errorMessage: "validation failed" });

    await expect(store.createReleaseDraft(
      setup!.workspace.id, repository!.id, failed.id, "broken"
    )).rejects.toThrow(/ready/i);
    expect(await store.currentRelease(setup!.workspace.id, repository!.id)).toBeNull();
  });
});
