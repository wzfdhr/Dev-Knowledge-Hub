import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import {
  createKnowledgeQualityStageExecutor,
  knowledgeQualityPipelineInputDigest
} from "./quality-stage";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("knowledge quality pipeline stage", () => {
  test("persists one immutable graph and reuses a deterministic quality artifact", async () => {
    const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-quality-snapshot-"));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-quality-artifacts-"));
    directories.push(snapshotRoot, artifactRoot);
    await mkdir(path.join(snapshotRoot, "data"));
    const readme = "# Operations\n\nRun npm test before release.\n";
    const csv = "email,count\nowner@example.com,1\n";
    await writeFile(path.join(snapshotRoot, "README.md"), readme);
    await writeFile(path.join(snapshotRoot, "data", "contacts.csv"), csv);

    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: "snapshot-1", workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-15T00:00:00.000Z"), storagePath: snapshotRoot
      },
      files: [
        {
          id: randomUUID(), workspaceId, snapshotId: "snapshot-1", path: "README.md",
          byteSize: Buffer.byteLength(readme), contentHash: hash(readme), language: "markdown"
        },
        {
          id: randomUUID(), workspaceId, snapshotId: "snapshot-1", path: "data/contacts.csv",
          byteSize: Buffer.byteLength(csv), contentHash: hash(csv), language: "csv"
        }
      ]
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const files = await store.listSnapshotFiles(workspaceId, snapshot.id);
    const inputDigest = knowledgeQualityPipelineInputDigest(snapshot, files, build.purpose);
    const artifactStore = new ArtifactStore(artifactRoot, store);
    await artifactStore.initialize();
    const execute = createKnowledgeQualityStageExecutor({ store, artifactStore });
    const run: PipelineStageRunRecord = {
      id: "run-1", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "lint", attempt: 1, status: "running", inputDigest, outputManifestIds: [],
      startedAt: "2026-07-15T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
    };
    const first = await execute(run);
    const second = await execute(run);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
    await expect(store.listRemediations(workspaceId, project.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceBuildId: build.id, issue: expect.objectContaining({ rule: "TABLE_SENSITIVE_FIELD" }) })
    ]));
    await expect(store.listRemediations(workspaceId, project.id)).resolves.toHaveLength(2);
    await expect(store.getKnowledgeGraph(workspaceId, project.id, build.id)).resolves.toEqual(expect.objectContaining({
      nodes: expect.arrayContaining([expect.objectContaining({ kind: "table", name: "contacts" })])
    }));
    expect(store.knowledgeArtifacts).toHaveLength(1);
    const artifact = store.knowledgeArtifacts[0]!;
    expect(artifact).toMatchObject({ stage: "lint", kind: "knowledge-quality", producer: "deterministic" });
    const quality = await artifactStore.getJson(artifact) as { issues: Array<{ rule: string }>; trust: { score: number } };
    expect(quality.issues).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "TABLE_SENSITIVE_FIELD" })]));
    expect(quality.trust.score).toBeLessThan(1);
  });
});
