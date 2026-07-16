import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "./memory-store";

describe("pipeline search document store", () => {
  test("persists only documents whose source artifact belongs to the same project build", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: randomUUID(), workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: "/tmp/snapshot"
      },
      files: []
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const artifact = await store.createArtifactWithAudit({
      id: randomUUID(), workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "synthesize", kind: "knowledge-pages", schemaVersion: 1, inputDigest: "b".repeat(64),
      contentDigest: "c".repeat(64), storageKey: `${project.id}/${snapshot.id}/synthesize/${"c".repeat(64)}.json`,
      sourceRefs: [], producer: "deterministic", createdAt: "2026-07-16T00:00:00.000Z"
    });
    const document = {
      documentKey: "architecture-overview:0", kind: "page" as const, title: "架构概览", content: "系统架构说明",
      citations: [], metadata: { pageSlug: "architecture-overview" }
    };

    await expect(store.savePipelineSearchDocuments({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      sourceArtifactId: artifact.id, documents: [document]
    })).resolves.toHaveLength(1);
    await expect(store.listPipelineSearchDocuments(workspaceId, project.id, build.id)).resolves.toEqual([
      expect.objectContaining({ sourceArtifactId: artifact.id, documentKey: document.documentKey })
    ]);
    await expect(store.savePipelineSearchDocuments({
      workspaceId, projectId: randomUUID(), snapshotId: snapshot.id, buildId: build.id,
      sourceArtifactId: artifact.id, documents: [document]
    })).rejects.toThrow("source artifact scope");
  });
});
