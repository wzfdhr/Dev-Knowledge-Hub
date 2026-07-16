import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import {
  createNormalizedSourcesStageExecutor,
  normalizedSourcesPipelineInputDigest
} from "./convert-stage";
import {
  createKnowledgeIrStageExecutor,
  knowledgeIrPipelineInputDigest,
  type KnowledgeIrStageStore
} from "./extract-stage";
import type { ArtifactManifest } from "./contracts";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(files: Record<string, string>) {
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-extract-stage-snapshot-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-extract-stage-artifacts-"));
  directories.push(snapshotRoot, artifactRoot);
  await Promise.all(Object.entries(files).map(async ([filePath, content]) => {
    await mkdir(path.join(snapshotRoot, path.dirname(filePath)), { recursive: true });
    await writeFile(path.join(snapshotRoot, filePath), content);
  }));

  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  const workspaceId = setup!.workspace.id;
  const project = (await store.listProjects(workspaceId))[0]!;
  const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
  const snapshot = await store.createSnapshot({
    snapshot: {
      id: "snapshot-1", workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
      ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
    },
    files: Object.entries(files).map(([filePath, content]) => ({
      id: randomUUID(), workspaceId, snapshotId: "snapshot-1", path: filePath,
      byteSize: Buffer.byteLength(content), contentHash: hash(content), language: null
    }))
  });
  const { build } = await store.createBuild({
    workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
    snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
  });
  const snapshotFiles = await store.listSnapshotFiles(workspaceId, snapshot.id);
  const convertDigest = normalizedSourcesPipelineInputDigest(snapshot, snapshotFiles, build.purpose);
  const artifactStore = new ArtifactStore(artifactRoot, store);
  await artifactStore.initialize();
  const convertRun: PipelineStageRunRecord = {
    id: "convert-run", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
    stage: "convert", attempt: 1, status: "running", inputDigest: convertDigest, outputManifestIds: [],
    startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
  };

  return { artifactStore, build, convertRun, project, repository: repository!, snapshot, snapshotRoot, store };
}

function stageStore(prepared: Awaited<ReturnType<typeof fixture>>, manifests: Map<string, ArtifactManifest>): KnowledgeIrStageStore {
  Object.assign(prepared.store, {
    findArtifactById: async (artifactId: string) => manifests.get(artifactId) ?? null
  });
  return prepared.store as unknown as KnowledgeIrStageStore;
}

describe("knowledge IR pipeline stage", () => {
  test("creates one unified deterministic IR artifact from the upstream normalized sources", async () => {
    const prepared = await fixture({
      "README.md": "# Runbook\n\nDeploy safely.\n",
      "src/app.ts": "export function answer() { return 42; }\n",
      "src/Panel.vue": "<script setup lang=\"ts\">\nconst title = 'Panel'\n</script>\n<template><main>{{ title }}</main></template>\n"
    });
    const convert = await createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore })(prepared.convertRun);
    const upstream = prepared.store.knowledgeArtifacts.find((artifact) => artifact.id === convert.outputManifestIds![0])!;
    const manifests = new Map([[upstream.id, upstream]]);
    const run: PipelineStageRunRecord = {
      ...prepared.convertRun,
      id: "extract-run",
      stage: "extract",
      outputManifestIds: convert.outputManifestIds!,
      inputDigest: knowledgeIrPipelineInputDigest(prepared.snapshot, prepared.build.purpose, convert.outputManifestIds!)
    };
    const execute = createKnowledgeIrStageExecutor({
      store: stageStore(prepared, manifests), artifactStore: prepared.artifactStore
    });

    const first = await execute(run);
    const second = await execute(run);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
    const artifact = prepared.store.knowledgeArtifacts.find((candidate) => candidate.id === first.outputManifestIds![0])!;
    expect(artifact).toMatchObject({ stage: "extract", kind: "knowledge-ir", producer: "deterministic" });
    await expect(prepared.artifactStore.getJson(artifact)).resolves.toEqual(expect.objectContaining({
      schemaVersion: 1,
      snapshotId: prepared.snapshot.id,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "README.md" }),
        expect.objectContaining({ path: "src/app.ts" }),
        expect.objectContaining({ path: "src/Panel.vue" })
      ]),
      symbols: expect.arrayContaining([expect.objectContaining({ name: "answer" })]),
      documents: expect.arrayContaining([expect.objectContaining({ text: "Deploy safely." })])
    }));
  });

  test("rejects missing, snapshot-mismatched, and cross-project upstream manifests", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n" });
    const convert = await createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore })(prepared.convertRun);
    const upstream = prepared.store.knowledgeArtifacts.find((artifact) => artifact.id === convert.outputManifestIds![0])!;
    const manifests = new Map([[upstream.id, upstream]]);
    const execute = createKnowledgeIrStageExecutor({
      store: stageStore(prepared, manifests), artifactStore: prepared.artifactStore
    });
    const validRun: PipelineStageRunRecord = {
      ...prepared.convertRun,
      id: "extract-run",
      stage: "extract",
      outputManifestIds: convert.outputManifestIds!,
      inputDigest: knowledgeIrPipelineInputDigest(prepared.snapshot, prepared.build.purpose, convert.outputManifestIds!)
    };

    await expect(execute({ ...validRun, outputManifestIds: [], inputDigest: knowledgeIrPipelineInputDigest(prepared.snapshot, prepared.build.purpose, []) }))
      .rejects.toThrow("requires at least one upstream manifest");
    await expect(execute({ ...validRun, snapshotId: "other-snapshot" }))
      .rejects.toThrow("does not match the project build and snapshot");
    manifests.set(upstream.id, { ...upstream, projectId: "other-project" });
    await expect(execute(validRun)).rejects.toThrow("does not match the project build and snapshot");
  });
});
