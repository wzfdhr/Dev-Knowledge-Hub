import { describe, expect, test } from "vitest";

import { buildKnowledgeGraph } from "../knowledge/pipeline/graph";
import { MemoryAppStore } from "./memory-store";

describe("knowledge graph persistence", () => {
  test("persists one immutable build-scoped graph and isolates workspace reads", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0]!;
    const repository = await store.createRepository(setup!.workspace.id, { kind: "upload", name: "Source" }, project.id);
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: "snapshot-1", workspaceId: setup!.workspace.id, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date(), storagePath: "/tmp/snapshot-1"
      },
      files: []
    });
    const { build } = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const sourceRef = { snapshotId: snapshot.id, path: "src/main.ts", startLine: 1, endLine: 1, blobHash: "b".repeat(64) };
    const graph = buildKnowledgeGraph({
      projectId: project.id,
      ir: {
        schemaVersion: 1, snapshotId: snapshot.id,
        files: [{ path: "src/main.ts", language: "typescript", contentDigest: "c".repeat(64), lineCount: 1, sourceRef }],
        symbols: [], imports: [], documents: [], tables: [], sourceRefs: [sourceRef]
      }
    });

    await expect(store.saveKnowledgeGraph({
      workspaceId: setup!.workspace.id, projectId: project.id, snapshotId: snapshot.id, buildId: build.id, graph, actorId: setup!.admin.id
    })).resolves.toBeUndefined();
    await expect(store.getKnowledgeGraph(setup!.workspace.id, project.id, build.id)).resolves.toEqual(graph);
    await expect(store.saveKnowledgeGraph({
      workspaceId: setup!.workspace.id, projectId: project.id, snapshotId: snapshot.id, buildId: build.id, graph, actorId: setup!.admin.id
    })).rejects.toThrow("immutable");
    await expect(store.getKnowledgeGraph("another-workspace", project.id, build.id)).resolves.toBeNull();
  });
});
