import { describe, expect, test } from "vitest";

import { loadPublishedKnowledgeGraph } from "./graph-query";

const release = { id: "release-1", workspaceId: "workspace-1", repositoryId: "repository-1", buildId: "build-1", snapshotId: "snapshot-1", version: "v1", createdAt: new Date(), publishedAt: new Date() };
const graph = { nodes: [], edges: [] };

describe("loadPublishedKnowledgeGraph", () => {
  test("loads only a release belonging to the requested repository", async () => {
    const store = {
      currentRelease: async () => release,
      getRelease: async (_workspaceId: string, id: string) => id === "release-1" ? release : null,
      getKnowledgeGraph: async () => graph
    };

    await expect(loadPublishedKnowledgeGraph({ store, workspaceId: "workspace-1", projectId: "project-1", repositoryId: "repository-1" }))
      .resolves.toEqual({ release, graph });
    await expect(loadPublishedKnowledgeGraph({ store, workspaceId: "workspace-1", projectId: "project-1", repositoryId: "repository-1", releaseId: "other" }))
      .resolves.toBeNull();
  });

  test("does not return a graph for an unpublished or cross-repository release", async () => {
    const store = {
      currentRelease: async () => null,
      getRelease: async () => ({ ...release, repositoryId: "other-repository", publishedAt: null }),
      getKnowledgeGraph: async () => graph
    };

    await expect(loadPublishedKnowledgeGraph({ store, workspaceId: "workspace-1", projectId: "project-1", repositoryId: "repository-1" }))
      .resolves.toBeNull();
    await expect(loadPublishedKnowledgeGraph({ store, workspaceId: "workspace-1", projectId: "project-1", repositoryId: "repository-1", releaseId: "release-1" }))
      .resolves.toBeNull();
  });
});
