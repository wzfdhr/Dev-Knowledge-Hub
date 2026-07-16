import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import {
  createKnowledgeSynthesisStageExecutor,
  knowledgeSynthesisPipelineInputDigest
} from "./synthesize-stage";
import {
  createPipelineSearchIndexStageExecutor,
  pipelineSearchIndexInputDigest
} from "./index-stage";
import type { ArtifactManifest } from "./contracts";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("knowledge synthesis pipeline stage", () => {
  test("turns one project-owned graph artifact into reusable deterministic knowledge pages", async () => {
    const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-synthesize-snapshot-"));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-synthesize-artifacts-"));
    directories.push(snapshotRoot, artifactRoot);
    const sourcePath = "src/app.ts";
    const source = "export const answer = 42;\n";
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    await writeFile(path.join(snapshotRoot, sourcePath), source);

    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshotId = randomUUID();
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
      },
      files: [{
        id: randomUUID(), workspaceId, snapshotId, path: sourcePath,
        byteSize: Buffer.byteLength(source), contentHash: hash(source), language: "typescript"
      }]
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const artifactStore = new ArtifactStore(artifactRoot, store);
    await artifactStore.initialize();
    const graphManifest: ArtifactManifest = {
      id: randomUUID(), workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "graph", kind: "knowledge-graph", schemaVersion: 1, inputDigest: "b".repeat(64),
      contentDigest: "0".repeat(64), storageKey: "pending", sourceRefs: [], producer: "deterministic",
      createdAt: "2026-07-16T00:00:00.000Z"
    };
    const graphArtifact = await artifactStore.putJson({
      manifest: graphManifest,
      value: { schemaVersion: 1, snapshotId: snapshot.id, nodes: [], edges: [] }
    });
    const graphRun = await store.createStageRun({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "graph", attempt: 1, inputDigest: "c".repeat(64)
    });
    await store.transitionStageRun(workspaceId, project.id, graphRun.id, "queued", "running");
    await store.transitionStageRun(workspaceId, project.id, graphRun.id, "running", "succeeded", {
      outputManifestIds: [graphArtifact.manifest.id]
    });
    const inputDigest = knowledgeSynthesisPipelineInputDigest(snapshot, build.purpose, [graphArtifact.manifest.id]);
    const run: PipelineStageRunRecord = {
      id: "synthesize-run", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "synthesize", attempt: 1, status: "running", inputDigest, outputManifestIds: [],
      startedAt: "2026-07-16T00:00:01.000Z", finishedAt: null, errorCode: null, errorDetail: null
    };
    const execute = createKnowledgeSynthesisStageExecutor({ store, artifactStore });

    const first = await execute(run);
    const second = await execute(run);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
    const artifact = await store.findArtifactById(first.outputManifestIds![0]!);
    const value = await artifactStore.getJson(artifact!) as { output: { pages: Array<{ slug: string }> } };
    expect(value.output.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "architecture-overview" })
    ]));

    const synthRun = await store.createStageRun({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "synthesize", attempt: 1, inputDigest
    });
    await store.transitionStageRun(workspaceId, project.id, synthRun.id, "queued", "running");
    await store.transitionStageRun(workspaceId, project.id, synthRun.id, "running", "succeeded", {
      outputManifestIds: first.outputManifestIds
    });
    const indexDigest = pipelineSearchIndexInputDigest(snapshot, build.purpose, first.outputManifestIds!);
    const indexRun: PipelineStageRunRecord = {
      ...run,
      id: "index-run",
      stage: "index",
      inputDigest: indexDigest,
      outputManifestIds: []
    };
    const index = createPipelineSearchIndexStageExecutor({ store, artifactStore });

    const indexed = await index(indexRun);

    expect(indexed).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    await expect(store.listPipelineSearchDocuments(workspaceId, project.id, build.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "page", title: "架构概览", sourceArtifactId: first.outputManifestIds![0] })
      ])
    );
  });
});
